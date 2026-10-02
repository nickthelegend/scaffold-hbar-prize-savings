// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// Subset of the Hedera Token Service system contract at 0x167 used by PrizePool.
/// Struct layout matches the official IHederaTokenService for ABI compatibility.
interface IHederaTokenService {
    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType;
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    /// Creates a Fungible Token with the specified properties.
    /// @return responseCode SUCCESS is 22.
    /// @return tokenAddress The created token's address.
    function createFungibleToken(HederaToken memory token, int64 initialTotalSupply, int32 decimals)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    /// Mints an amount of the token to the treasury account.
    /// @param metadata For NFTs only; use empty array for fungible.
    /// @return responseCode SUCCESS is 22.
    function mintToken(address token, int64 amount, bytes[] memory metadata)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    /// Moves `amount` of a fungible token between accounts. The contract must be the sender or hold an allowance.
    function transferToken(address token, address sender, address recipient, int64 amount)
        external
        returns (int64 responseCode);

    /// Freezes `account` for `token`; requires the token's freeze key.
    function freezeToken(address token, address account) external returns (int64 responseCode);

    /// Unfreezes `account` for `token`; requires the token's freeze key.
    function unfreezeToken(address token, address account) external returns (int64 responseCode);

    /// Burns `amount` held by `account` (not the treasury); requires the token's wipe key.
    function wipeTokenAccount(address token, address account, int64 amount) external returns (int64 responseCode);
}
