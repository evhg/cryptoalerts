// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IStUsdsLike {
    function maxRedeem(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/// @title StUsdsExit
/// @notice Redeems as much of one owner's stUSDS as the pool will currently
///         pay out, and sends the USDS straight to that owner.
///
/// Trust model, by construction:
///  - The contract never holds the owner's funds. It spends the owner's stUSDS
///    allowance and names the owner as receiver in the same call.
///  - There is no parameter anywhere that can name another receiver. Whoever
///    controls the keeper key can only turn the owner's stUSDS into USDS in
///    the owner's own wallet, which is what the owner wants anyway.
///  - The optional tip to the block builder is capped by the owner, in
///    proportion to what was actually redeemed, so a tiny baited redemption
///    can only ever cost a tiny tip. The tip is paid from the ETH the keeper
///    sends with the call; anything above the cap is returned to the keeper.
///  - No upgrade path, no delegatecall, no token approvals given out.
contract StUsdsExit {
    IStUsdsLike public immutable stUsds;
    address public immutable owner;

    /// Account allowed to trigger a redemption (besides the owner).
    address public keeper;
    /// Never redeem for less than this many USDS (wad). Stops dust bait.
    uint256 public minAssetsFloor;
    /// Tip cap, in wei of ETH per whole USDS redeemed.
    uint256 public tipWeiPerUsds;
    /// Absolute tip cap per call, in wei.
    uint256 public maxTipWei;

    event Exit(uint256 shares, uint256 assets, uint256 tip);
    event Configured(address keeper, uint256 minAssetsFloor, uint256 tipWeiPerUsds, uint256 maxTipWei);

    error NotAuthorized();
    error NothingToRedeem();
    error BelowMinimum(uint256 assets, uint256 minimum);
    error RefundFailed();

    constructor(
        address stUsds_,
        address owner_,
        address keeper_,
        uint256 minAssetsFloor_,
        uint256 tipWeiPerUsds_,
        uint256 maxTipWei_
    ) {
        require(stUsds_ != address(0) && owner_ != address(0), "zero address");
        stUsds = IStUsdsLike(stUsds_);
        owner = owner_;
        _configure(keeper_, minAssetsFloor_, tipWeiPerUsds_, maxTipWei_);
    }

    /// @notice Owner-only: change the keeper and the limits.
    function configure(address keeper_, uint256 minAssetsFloor_, uint256 tipWeiPerUsds_, uint256 maxTipWei_) external {
        if (msg.sender != owner) revert NotAuthorized();
        _configure(keeper_, minAssetsFloor_, tipWeiPerUsds_, maxTipWei_);
    }

    function _configure(address keeper_, uint256 minAssetsFloor_, uint256 tipWeiPerUsds_, uint256 maxTipWei_) internal {
        keeper = keeper_;
        minAssetsFloor = minAssetsFloor_;
        tipWeiPerUsds = tipWeiPerUsds_;
        maxTipWei = maxTipWei_;
        emit Configured(keeper_, minAssetsFloor_, tipWeiPerUsds_, maxTipWei_);
    }

    /// @notice How many shares a call would redeem right now.
    function redeemable() public view returns (uint256 shares) {
        shares = stUsds.maxRedeem(owner); // min(owner's balance, pool liquidity)
        uint256 allowed = stUsds.allowance(owner, address(this));
        if (shares > allowed) shares = allowed;
    }

    /// @notice Redeem what is available, up to `maxShares`, to the owner.
    /// @param maxShares  Upper bound on shares to redeem (use type(uint256).max for "all").
    /// @param minAssets  Revert unless at least this many USDS come out.
    /// @dev msg.value is the tip offered to the block builder. It is paid only
    ///      after a successful redemption, capped by the owner's limits; the
    ///      rest goes back to the caller. Reverts (so nothing is paid and, sent
    ///      as a bundle, nothing is included) when there is nothing worthwhile.
    function exit(uint256 maxShares, uint256 minAssets) external payable returns (uint256 assets) {
        if (msg.sender != keeper && msg.sender != owner) revert NotAuthorized();

        uint256 shares = redeemable();
        if (shares > maxShares) shares = maxShares;
        if (shares == 0) revert NothingToRedeem();

        assets = stUsds.redeem(shares, owner, owner);

        uint256 minimum = minAssets > minAssetsFloor ? minAssets : minAssetsFloor;
        if (assets < minimum) revert BelowMinimum(assets, minimum);

        uint256 tip = msg.value;
        if (tip > 0) {
            uint256 cap = (assets * tipWeiPerUsds) / 1e18;
            if (cap > maxTipWei) cap = maxTipWei;
            if (tip > cap) tip = cap;
            if (tip > 0) {
                // Fixed gas allowance and no return data copied: a hostile builder
                // contract can neither burn this call's gas nor bloat its memory.
                // A builder that cannot receive ETH this way simply forgoes the tip.
                address builder = block.coinbase;
                bool paid;
                assembly ("memory-safe") {
                    paid := call(60000, builder, tip, 0, 0, 0, 0)
                }
                if (!paid) tip = 0;
            }
            uint256 refund = msg.value - tip;
            if (refund > 0) {
                address refundTo = msg.sender;
                bool ok;
                assembly ("memory-safe") {
                    ok := call(gas(), refundTo, refund, 0, 0, 0, 0)
                }
                if (!ok) revert RefundFailed();
            }
        }

        emit Exit(shares, assets, tip);
    }
}
