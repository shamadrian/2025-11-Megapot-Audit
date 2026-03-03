import { ethers } from "hardhat";
import { getWaffleExpect, getAccounts } from "@utils/test/index";
import { usdc } from "@utils/common";
import { deployJackpotSystem } from "@utils/test/jackpotFixture";

const expect = getWaffleExpect();

/**
 * M-03 PoC
 *
 * Demonstrates that if the entropy provider is updated after `runJackpot()`
 * but before the provider callback arrives, the original provider's callback
 * is rejected by `onlyEntropy` and the drawing remains locked.
 *
 * The test uses the repository's `ScaledEntropyProviderMock` to simulate the
 * provider callback (the mock calls back into `jackpot.scaledEntropyCallback`
 * so the `msg.sender` inside the jackpot will be the provider contract address).
 */
describe("PoC M-03: entropy provider swap blocks callback", function () {
  this.timeout(60_000);

  let owner: any;
  let buyerOne: any;

  let jackpotSystem: any;
  let jackpot: any;
  let providerA: any;

  beforeEach(async () => {
    [owner, , , buyerOne] = await getAccounts();

    jackpotSystem = await deployJackpotSystem();
    jackpot = jackpotSystem.jackpot;
    providerA = jackpotSystem.entropyProvider; // ScaledEntropyProviderMock deployed by fixture

    // Standard initialization (matches C4PoC template)
    await jackpot
      .connect(owner.wallet)
      .initialize(
        jackpotSystem.usdcMock.getAddress(),
        await jackpotSystem.jackpotLPManager.getAddress(),
        await jackpotSystem.jackpotNFT.getAddress(),
        providerA.getAddress(),
        await jackpotSystem.payoutCalculator.getAddress(),
      );

  // Initialize LP deposits and fund the LP so initializeJackpot succeeds
  await jackpot.connect(owner.wallet).initializeLPDeposits(usdc(10000000));

  // Approve and deposit LP funds (owner deposits) so pendingDeposits > 0
  await jackpotSystem.usdcMock.connect(owner.wallet).approve(jackpot.getAddress(), usdc(1000000));
  await jackpot.connect(owner.wallet).lpDeposit(usdc(1000000));

  await jackpot.connect(owner.wallet).initializeJackpot(BigInt((await ethers.provider.getBlockNumber())) + BigInt(1));
  });

  it("locks the draw when provider is swapped before callback arrives", async () => {
    // Caller funds required entropy fee
    const fee = await jackpot.getEntropyCallbackFee();

    // Any account can call runJackpot; use buyerOne
    await jackpot.connect(buyerOne.wallet).runJackpot({ value: fee });

    // At this point the drawing should be locked awaiting callback
    const drawingId = await jackpot.currentDrawingId();
    let ds = await jackpot.getDrawingState(drawingId);
    expect(ds.jackpotLock).to.equal(true);

    // Deploy a new provider (providerB) and set it as the current entropy provider
    const providerB = await jackpotSystem.deployer.deployScaledEntropyProviderMock(
      jackpotSystem.deploymentParams.entropyFee,
      await jackpot.getAddress(),
      jackpot.interface.getFunction("scaledEntropyCallback").selector,
    );

    await jackpot.connect(owner.wallet).setEntropy(await providerB.getAddress());

    // Now simulate the original provider (providerA) delivering the callback.
    // Because the contract's onlyEntropy modifier compares msg.sender to the current
    // entropy address (which is now providerB), this callback should revert.
    const randomNumbers = [[1, 2, 3, 4, 5], [1]];

    await expect(providerA.randomnessCallback(randomNumbers)).to.be.revertedWithCustomError(
      jackpot,
      "UnauthorizedEntropyCaller",
    );

    // The drawing should remain locked after the failed callback attempt
    ds = await jackpot.getDrawingState(drawingId);
    expect(ds.jackpotLock).to.equal(true);
  });
});
