// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IQToken {
    function approve(address, uint256) external returns (bool);
}

interface IQDaiUsds {
    function daiToUsds(address usr, uint256 wad) external;
}

interface IQFlash {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface IQPool {
    function add_liquidity(uint256[] calldata amounts, uint256 minMint) external returns (uint256);
    function remove_liquidity_one_coin(uint256 burn, int128 i, uint256 minOut) external returns (uint256);
}

/// @title StUsdsQuoter
/// @notice Tells exactly how many stUSDS a given amount of USDS buys at the
///         Curve stUSDS/USDS pool through its add-liquidity / remove-one-coin
///         path, by doing the purchase with flash-minted DAI and undoing it.
///
/// Meant to be called off-chain (eth_call). Every purchase is reverted, so the
/// contract never holds or moves anything for real, has no owner and no
/// permissions, and it is harmless for anyone to call.
contract StUsdsQuoter {
    address public constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address public constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address public constant POOL = 0x2C7C98A3b1582D83c43987202aEFf638312478aE;

    error Quoted(uint256 poolTokens, uint256 shares);
    error OnlyFlash();

    /// For each amount of USDS: the pool tokens minted on the way and the stUSDS received (0 if that size fails).
    function quote(uint256[] calldata amounts) external returns (uint256[] memory poolTokens, uint256[] memory shares) {
        poolTokens = new uint256[](amounts.length);
        shares = new uint256[](amounts.length);
        for (uint256 i = 0; i < amounts.length; i++) {
            try this.one(amounts[i]) {}
            catch (bytes memory r) {
                if (r.length == 68 && bytes4(r) == Quoted.selector) {
                    uint256 a;
                    uint256 b;
                    assembly ("memory-safe") {
                        a := mload(add(r, 36))
                        b := mload(add(r, 68))
                    }
                    poolTokens[i] = a;
                    shares[i] = b;
                }
            }
        }
    }

    /// Always reverts: with `Quoted` when the purchase would work.
    function one(uint256 amount) external {
        IQFlash(FLASH).flashLoan(address(this), DAI, amount, "");
        revert();
    }

    function onFlashLoan(address initiator, address, uint256 amount, uint256, bytes calldata) external returns (bytes32) {
        if (msg.sender != FLASH || initiator != address(this)) revert OnlyFlash();
        IQToken(DAI).approve(DAI_USDS, amount);
        IQDaiUsds(DAI_USDS).daiToUsds(address(this), amount);
        IQToken(USDS).approve(POOL, amount);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount;
        uint256 lp = IQPool(POOL).add_liquidity(amounts, 0);
        uint256 out = IQPool(POOL).remove_liquidity_one_coin(lp, 1, 0);
        revert Quoted(lp, out);
    }
}
