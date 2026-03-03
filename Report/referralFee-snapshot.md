# referralFee snapshot error

## Description

The `emergencyRefundTickets` path computes referral deductions using the *current* global `referralFee` rather than the fee that was in effect when the ticket was purchased. This means refunds can under- or over-pay ticket holders if `referralFee` was changed between purchase and refund.

Offending code (excerpt from `contracts/Jackpot.sol`):

```solidity
uint256 refundAmount = ticketInfo.referralScheme == bytes32(0)
    ? drawingState[ticketInfo.drawingId].ticketPrice
    : drawingState[ticketInfo.drawingId].ticketPrice * (PRECISE_UNIT - referralFee) / PRECISE_UNIT;
```

The calculation uses the mutable `referralFee` variable instead of a per-drawing snapshot.


## Impact

- Users may receive smaller refunds than they reasonably expected (under-refund) or larger refunds (over-refund) depending on admin changes to `referralFee` after purchase.
- For repeated purchases this can scale to substantial monetary loss — e.g., a 20% delta on a user who bought many tickets.
- Users can be deprived of amounts they paid for at purchase-time or gained amounts they do not deserve.

## High-level example

1. Admin sets `referralFee = 10%`.
2. Alice purchases 1000 tickets with a referrer.
3. Later, admin updates `referralFee = 30%`.
4. Emergency mode is enabled and Alice calls `emergencyRefundTickets(...)`.
5. Contract computes refunds using 30% and returns 0.7 USDC per ticket instead of the 0.9 USDC Alice expected — a loss of 0.2 USDC per ticket (200 USDC total for 1000 tickets).



## Mitigation steps

Recommended fixes (ordered by safety / ease):

1. Snapshot the referral fee per drawing (low-risk, recommended):
   - Add `uint256 referralFee;` to `DrawingState` and set `newDrawingState.referralFee = referralFee;` inside `_setNewDrawingState(...)`.
   - Use `drawingState[ticketInfo.drawingId].referralFee` when computing refunds and when distributing referral fees for that drawing.
   - This mirrors the existing snapshot pattern used for `referralWinShare` and preserves purchase-time semantics.

