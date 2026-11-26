// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CondProbe
/// @notice A test fixture with no tokens in it. It answers one question per block builder: "do you run our
///         conditional (end-of-block) bundles?"
///
/// `set()` writes one storage slot. `claim()` only works later in the same block, pays the block builder a few cents
/// from the ETH held here and clears the slot. So a `set()` sent privately to one builder, with a conditional bundle
/// holding `claim()` already waiting at that builder, lands as a pair only if the builder really tries conditional
/// bundles after the storage they name has changed. Nobody else can call either function, so no rival can interfere.
/// The ETH held can only go to a builder (capped per claim) or back to `owner`.
contract CondProbe {
    address public immutable owner;
    address public immutable keeper;
    address public immutable setter;
    uint256 public flag; // slot 0: the block in which set() ran
    uint256 public constant MAX_TIP = 0.001 ether;

    event Set(uint256 blockNumber);
    event Claimed(uint256 blockNumber, uint256 tip);

    constructor(address owner_, address keeper_, address setter_) payable {
        owner = owner_;
        keeper = keeper_;
        setter = setter_;
    }

    function set() external {
        require(msg.sender == setter, "not setter");
        flag = block.number;
        emit Set(block.number);
    }

    function claim(uint256 tip) external {
        require(msg.sender == keeper, "not keeper");
        require(flag == block.number, "not set in this block");
        flag = 0;
        if (tip > MAX_TIP) tip = MAX_TIP;
        if (tip > address(this).balance) tip = address(this).balance;
        (bool ok,) = block.coinbase.call{value: tip, gas: 60000}("");
        emit Claimed(block.number, ok ? tip : 0);
    }

    function withdraw() external {
        require(msg.sender == keeper || msg.sender == owner, "not allowed");
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}
