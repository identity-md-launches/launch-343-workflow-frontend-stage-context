// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Taskboard (TASK) launch token
/// @notice Fixed-supply ERC-20. The whole supply of 1,000,000,000 TASK (10^27 minor units) is
///         minted once, to the deployer, in the constructor. There is no owner, no mint, no burn,
///         no pause, no blocklist, no fee and no upgrade path.
/// @dev Deployed by the project factory, which therefore receives the supply and splits it between
///      the liquidity pool and the reward distributor. The contract intentionally imports nothing.
contract LaunchToken {
    string public constant name = "Taskboard";
    string public constant symbol = "TASK";
    uint8 public constant decimals = 18;

    /// @notice 1,000,000,000 tokens with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor() {
        totalSupply = TOTAL_SUPPLY;
        balanceOf[msg.sender] = TOTAL_SUPPLY;
        emit Transfer(address(0), msg.sender, TOTAL_SUPPLY);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
            emit Approval(from, msg.sender, allowed - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 fromBalance = balanceOf[from];
        if (fromBalance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = fromBalance - amount;
            // Supply is fixed, so the sum of balances never exceeds TOTAL_SUPPLY and cannot overflow.
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
