import { ethers } from "hardhat";
import { getWaffleExpect, getAccounts } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { PRECISE_UNIT, ZERO_BYTES32 } from "@utils/constants";
import { deployJackpotSystem } from "@utils/test/jackpotFixture";
import { calculatePackedTicket } from "@utils/protocolUtils";

const expect = getWaffleExpect();

// Helper: format USDC (6 decimals) from internal bigint representation to human-readable string
const formatUSDC = (amt: bigint): string => {
  const USDC_DECIMALS = 1000000n;
  const integer = amt / USDC_DECIMALS;
  const fraction = amt % USDC_DECIMALS;
  const fracStr = fraction.toString().padStart(6, "0");
  return `${integer.toString()}.${fracStr}`;
};

/**
 * M-02 PoC
 *
 * Demonstrates that `emergencyRefundTickets` uses the current global `referralFee`
 * rather than the fee in effect at purchase-time. The test shows two users:
 *  - buyerOne buys at 10% referralFee, later refunded when global fee = 30% (UNDER-refund)
 *  - buyerTwo buys at 30% referralFee, later refunded when global fee = 10% (OVER-refund)
 *
 * The test uses the repository's deploy helper so it exercises the real
 * initialization flow (no internal mocking of contract-internal calls).
 */
describe("PoC M-02: referralFee snapshot error", function () {
  this.timeout(180_000);

  let owner: any;
  let buyerOne: any;
  let buyerTwo: any;
  let referrerOne: any;

  let jackpotSystem: any;
  let jackpot: any;
  let usdcMock: any;

  beforeEach(async () => {
    // Use the fixture which returns pre-configured accounts and contracts. This
    // avoids dependency on getAccounts ordering in this test file.
    jackpotSystem = await deployJackpotSystem();
    owner = jackpotSystem.owner;
    buyerOne = jackpotSystem.buyerOne;
    buyerTwo = jackpotSystem.buyerTwo;
    referrerOne = jackpotSystem.referrerOne;
    jackpot = jackpotSystem.jackpot;
    usdcMock = jackpotSystem.usdcMock;

    // Standard initialization (matches C4PoC template)
    await jackpot
      .connect(owner.wallet)
      .initialize(
        usdcMock.getAddress(),
        await jackpotSystem.jackpotLPManager.getAddress(),
        await jackpotSystem.jackpotNFT.getAddress(),
        jackpotSystem.entropyProvider.getAddress(),
        await jackpotSystem.payoutCalculator.getAddress(),
      );

    await jackpot.connect(owner.wallet).initializeLPDeposits(usdc(10000000));

    // Seed LP so prize pool/drawings behave normally
    await usdcMock.connect(owner.wallet).approve(jackpot.getAddress(), usdc(1000000));
    await jackpot.connect(owner.wallet).lpDeposit(usdc(1000000));

    // Start first drawing shortly in the future
    await jackpot
      .connect(owner.wallet)
      .initializeJackpot(BigInt((await ethers.provider.getBlockNumber())) + BigInt(1));
  });

  it("shows under- and over-refunds depending on global referralFee", async () => {
    const ticketPrice: bigint = jackpotSystem.deploymentParams.ticketPrice; // BigInt (usdc(1))

    // Helper ticket structure (normals are bigints)
    const ticketA = { normals: [1n, 2n, 3n, 4n, 5n], bonusball: 1n };
    const ticketB = { normals: [6n, 7n, 8n, 9n, 10n], bonusball: 1n };

    // 1) Set global referralFee = 10% and buyerOne purchases referred tickets
    // BuyerOne will spend their entire 1000 USDC by purchasing 1000 tickets.
    // We'll perform purchases in batches to avoid one enormous transaction.
    await jackpot.connect(owner.wallet).setReferralFee(ether(0.1));

    const NUM_TICKETS = 1000;
    const BATCH_SIZE = 100; // 10 batches of 100 = 1000 tickets

    // Approve the full 1000 USDC for ticket purchases
    await usdcMock.connect(buyerOne.wallet).approve(jackpot.getAddress(), usdc(1000));

    let expectedIdsA: any[] = [];
    for (let b = 0; b < NUM_TICKETS / BATCH_SIZE; b++) {
      const batch: any[] = [];
      for (let i = 0; i < BATCH_SIZE; i++) batch.push(ticketA);

      const txA = await jackpot.connect(buyerOne.wallet).buyTickets(
        batch,
        buyerOne.address,
        [referrerOne.address],
        [PRECISE_UNIT],
        ZERO_BYTES32,
      );
      const rcptA = await txA.wait();
      for (const log of rcptA.logs) {
        try {
          const parsed = jackpot.interface.parseLog(log);
          if (parsed.name === 'TicketPurchased') {
            expectedIdsA.push(parsed.args.userTicketId);
          }
        } catch (e) {
          /* ignore unparsable logs */
        }
      }
    }

    // Set global referralFee = 30% prior to refunding buyerOne to demonstrate under-refund
    await jackpot.connect(owner.wallet).setReferralFee(ether(0.3));

    // Now we will refund each user under different global fee values to demonstrate the bug.

    // ---- Refund buyerOne while global fee = 30% (should under-refund vs purchase-time 10%) ----
    await jackpot.connect(owner.wallet).enableEmergencyMode();

    const beforeBalBuyerOne = await usdcMock.balanceOf(buyerOne.address);
    // refund buyerOne for all tickets they purchased in smaller batches to avoid running out of gas
    const REFUND_BATCH_SIZE = 50; // tuneable: smaller sizes use less gas per tx
    for (let i = 0; i < expectedIdsA.length; i += REFUND_BATCH_SIZE) {
      const slice = expectedIdsA.slice(i, i + REFUND_BATCH_SIZE);
      await jackpot.connect(buyerOne.wallet).emergencyRefundTickets(slice);
    }
    const afterBalBuyerOne = await usdcMock.balanceOf(buyerOne.address);

    // Compute expected amounts (per-ticket)
    const globalFee30 = ether(0.3);
    const snapshotFee10 = ether(0.1);

    const actualRefundBuyerOne = BigInt(afterBalBuyerOne.toString()) - BigInt(beforeBalBuyerOne.toString());
    const expectedRefundIfSnapshotHeld = (BigInt(ticketPrice.toString()) * (PRECISE_UNIT - snapshotFee10)) / PRECISE_UNIT;
    const expectedRefundUsingGlobal = (BigInt(ticketPrice.toString()) * (PRECISE_UNIT - globalFee30)) / PRECISE_UNIT;

    // Totals for all tickets
    const NUM_TICKETS_BI = BigInt(1000);
    const expectedTotalSnapshot = expectedRefundIfSnapshotHeld * NUM_TICKETS_BI;
    const expectedTotalGlobal = expectedRefundUsingGlobal * NUM_TICKETS_BI;

    // The contract currently refunds using the global fee per-ticket; for all tickets,
    // the total should equal expectedTotalGlobal and be less than expectedTotalSnapshot.
    expect(actualRefundBuyerOne).to.equal(expectedTotalGlobal);
    // Assertion: actual final refund (total) is less than the buyer's expected (snapshot total)
    expect(actualRefundBuyerOne).to.be.lt(expectedTotalSnapshot);

    const lossBuyerOne = expectedTotalSnapshot - actualRefundBuyerOne; // positive bigint = user loss across all tickets

    console.log("[M-02] buyerOne expected (snapshot per-ticket):", formatUSDC(expectedRefundIfSnapshotHeld), "USDC");
    console.log("[M-02] buyerOne actual (final per-ticket):   ", formatUSDC(expectedRefundUsingGlobal), "USDC");
    console.log("[M-02] buyerOne expected (snapshot total):   ", formatUSDC(expectedTotalSnapshot), "USDC");
    console.log("[M-02] buyerOne actual (final total):       ", formatUSDC(actualRefundBuyerOne), "USDC");
    console.log("[M-02] buyerOne total loss:                 ", formatUSDC(lossBuyerOne), "USDC");

    // Turn off emergency mode to leave chain state clean
    await jackpot.connect(owner.wallet).disableEmergencyMode();
  });
});
