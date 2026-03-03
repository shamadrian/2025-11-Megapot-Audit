# entropy provider swap can block callback and lock drawing

## Description

The contract enforces that only the current `entropy` address may call the `scaledEntropyCallback` (via the `onlyEntropy` modifier). If the `entropy` address is changed (for example, the owner swaps providers) after a randomness request but before the original provider calls back, the original provider's callback will be rejected and the drawing will remain locked.

Key code snippets (from `contracts/Jackpot.sol`):

```solidity
modifier onlyEntropy() {
    if (msg.sender != address(entropy)) revert JackpotErrors.UnauthorizedEntropyCaller();
    _;
}

function runJackpot() external payable nonReentrant noEmergencyMode {
    _lockJackpot();
    // request randomness from `entropy` provider
    entropy.requestAndCallbackScaledRandomness{value: fee}(...);
}

function scaledEntropyCallback(bytes32, uint256[][] memory _randomNumbers, bytes memory) external nonReentrant onlyEntropy {
    DrawingState storage currentDrawingState = drawingState[currentDrawingId];
    if (!currentDrawingState.jackpotLock) revert JackpotErrors.JackpotNotLocked();
    // process callback, finalize drawing
}
```

Because the callback is strictly checked against the mutable `entropy` address, a swap of the provider invalidates in-flight requests from the previous provider.

There is currently no contract logic that blocks such an action or safeguard such action to ensure that the jackpot could perform it's intended duties without any possible interference.


## Impact
- The issue is primarily an availability and recoverability risk. It does not directly allow theft of funds, but it can block normal operations and require manual recovery.
- A locked drawing prevents further ticket purchases and blocks normal progression of the jackpot until the issue is resolved (owner intervention or manual state fixes). This is a denial-of-service / availability issue and can be escalated if the owner is unresponsive.


## High-level example

1. an EOA calls `runJackpot()` which locks the drawing and calls `entropy.requestAndCallbackScaledRandomness(...)` on provider A.
2. Before provider A returns, operator or admin calls `setEntropy(...)` to provider B.
3. Provider A attempts to invoke the callback; `onlyEntropy` rejects it because `entropy` now equals provider B, reverting the callback and leaving the drawing locked.
4. The system cannot complete settlement until the owner manually recovers (e.g., sets `entropy` back to provider A and allows it to callback, or runs a manual settlement path).


## Mitigation steps

Recommended fixes (in order of safety):

1. Prevent provider swaps while a drawing is locked (very low-risk — recommended first):
    - Add a simple guard in `setEntropy(...)` to disallow changing the `entropy` address when the current drawing is locked (i.e. after `runJackpot()` and before the callback completes):




