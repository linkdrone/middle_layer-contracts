import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ethers } from "hardhat";
import {
  AccountFactory,
  AccountFactory__factory,
  EntryPoint,
  EntryPoint__factory,
  TestPaymaster,
  TestPaymaster__factory,
  TestToken,
  TestToken__factory,
  ZkProverZkpVerifierWrapper__factory,
} from "../typechain-types";
import { ZkProverZkpVerifierWrapper } from "../typechain-types/contracts/zkp/ZkProverZkpVerifierWrapper";
import { Signers } from "./types";

import { expect } from "chai";
import { BigNumber, Wallet } from "ethers";
import { parseEther } from "ethers/lib/utils";
import type { UserOperationStruct } from "../typechain-types/contracts/EntryPoint";
import { createAccount, createAccountOwner, fund } from "./testutils";
import { compile_yul, halo2zkpVerifierAbi } from "../scripts/utils";
import ProofData from "./zkp_output/proof.json";

const AddressZero = ethers.constants.AddressZero;
const HashZero = ethers.constants.HashZero;
const ONE_ETH = parseEther("1");
const TWO_ETH = parseEther("2");
const FIVE_ETH = parseEther("5");

const DefaultsForUserOp: UserOperationStruct = {
  sender: ethers.constants.AddressZero,
  nonce: 0,
  initCode: "0x",
  callData: "0x",
  callGasLimit: 0,
  verificationGasLimit: 100000, // default verification gas. will add create2 cost (3200+200*length) if initCode exists
  preVerificationGas: 21000, // should also cover calldata cost.
  maxFeePerGas: 0,
  maxPriorityFeePerGas: 1e9,
  paymasterAndData: "0x",
  signature: "0x",
};

async function generateAccountAndERC20TransferOp(
  admin: SignerWithAddress,
  accountFactory: AccountFactory,
  entryPoint: EntryPoint,
  testToken: TestToken
) {
  const accountOwner = createAccountOwner();

  let { proxy: account } = await createAccount(
    admin,
    accountOwner.address,
    entryPoint.address,
    accountFactory
  );

  const amount = ONE_ETH.div(10000);

  await testToken
    .transfer(account.address, amount)
    .then(async (t) => await t.wait());

  await fund(account);

  const transferCallData = (
    await testToken.populateTransaction.transfer(accountOwner.address, amount)
  ).data;
  const callData = (
    await account.populateTransaction.execute(
      testToken.address,
      0,
      transferCallData!
    )
  ).data;

  const op: UserOperationStruct = {
    ...DefaultsForUserOp,
    sender: account.address,
    nonce: 1,
    callData: callData!,
    callGasLimit: 10000000, // TODO
    verificationGasLimit: 10000000, // TODO
    maxFeePerGas: BigNumber.from(1016982020), // TODO
  };

  return { account, op, accountOwner };
}

describe("EntryPoint", function () {
  this.timeout(2000000);

  let verifier: ZkProverZkpVerifierWrapper;
  let entryPoint: EntryPoint;
  let paymaster: TestPaymaster;
  let accountFactory: AccountFactory;
  let testToken: TestToken;

  // Accounts
  let beneficiary: SignerWithAddress;
  let paymasterOwner: SignerWithAddress;
  let dummyAddress: SignerWithAddress;
  const provider = ethers.provider;

  before(async function () {
    this.signers = {} as Signers;

    const signers: SignerWithAddress[] = await ethers.getSigners();
    this.signers.admin = signers[0];
    beneficiary = signers[1];
    paymasterOwner = signers[2];
    dummyAddress = signers[3];

    let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");
    // console.log(`verifiyCode ${verifyCode}`)
    const factory = new ethers.ContractFactory(
      halo2zkpVerifierAbi,
      verifyCode,
      this.signers.admin
    );
    const verifyContract = await factory.deploy();
    console.log(`contract address ${verifyContract.address}`);

    verifier = await new ZkProverZkpVerifierWrapper__factory(
      this.signers.admin
    ).deploy(verifyContract.address);
    console.log("verifier.address:", verifier.address);

    entryPoint = await new EntryPoint__factory(this.signers.admin).deploy(
      verifier.address
    );
    console.log("entryPoint.address:", entryPoint.address);

    paymaster = await new TestPaymaster__factory(paymasterOwner).deploy(
      entryPoint.address
    );
    console.log("paymaster.address:", paymaster.address);

    accountFactory = await new AccountFactory__factory(
      this.signers.admin
    ).deploy(entryPoint.address);
    console.log("accountFactory.address:", accountFactory.address);

    testToken = await new TestToken__factory(this.signers.admin).deploy();
    console.log("testToken.address:", testToken.address);
  });

  it("should deposit for transfer into EntryPoint", async () => {
    const paymasterStake = ONE_ETH.mul(100);
    const paymasterDeposit = paymasterStake;

    // await paymaster.addStake(2, { value: paymasterStake });
    await paymaster.deposit({ value: paymasterDeposit });

    expect(await entryPoint.balanceOf(paymaster.address)).to.eql(
      paymasterStake
    );

    const depositInfo = await entryPoint.getDepositInfo(paymaster.address);
    expect(depositInfo.deposit).to.eql(paymasterStake);
    expect(depositInfo.staked).to.eql(false);
    expect(depositInfo.stake.toNumber()).to.eql(0);
    expect(depositInfo.unstakeDelaySec).to.eql(0);
    expect(depositInfo.withdrawTime.toNumber()).to.eql(0);
  });

  it("should succeed to handleOps", async function () {
    const txLength = 129;
    const ops: UserOperationStruct[] = [];
    const accountOwners: Wallet[] = [];
    for (let i = 0; i < txLength; i++) {
      const { account, op, accountOwner } =
        await generateAccountAndERC20TransferOp(
          this.signers.admin,
          accountFactory,
          entryPoint,
          testToken
        );
      op.paymasterAndData = paymaster.address;
      ops.push(op);
      accountOwners.push(accountOwner);

      console.log(
        "generateAccountAndERC20TransferOp:",
        account.address,
        ", index: ",
        i
      );
    }

    const resp = await entryPoint
      .handleOps(
        ops,
        ProofData.proof,
        [BigNumber.from(ProofData.pub_ins[0])],
        beneficiary.address,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        }
      )
      .then(async (t) => await t.wait());

    const normalTx = await testToken
      .transfer(dummyAddress.address, BigNumber.from(100))
      .then(async (t) => await t.wait());

    console.log(
      `handleOps gasUsed ${JSON.stringify(
        resp.gasUsed.toString()
      )} avg gas ${JSON.stringify(
        resp.gasUsed.div(BigNumber.from(txLength)).toString()
      )} normal gas ${JSON.stringify(normalTx.gasUsed.toString())}`
    );

    for (const accountOwner of accountOwners) {
      const balance = await testToken.balanceOf(accountOwner.address);
      console.warn(
        "accountOwner.address:",
        accountOwner.address,
        ", balance:",
        balance + ""
      );
    }

    // console.warn("resp.events:", resp.events);
  });
});
