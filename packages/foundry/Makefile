.PHONY: account compile format lint test verify

# List account
account:
	@node scripts-js/checkAccountBalance.js

# Compile contracts
compile:
	forge compile

# Format code
format:
	forge fmt && prettier --write "scripts-js/**/*.js" "test/e2e/**/*.js"

# Lint code
lint:
	forge fmt --check && prettier --check "scripts-js/**/*.js" "test/e2e/**/*.js"

# Run tests
test:
	forge test

# Verify contracts on Sourcify (Hedera is now supported on the main Sourcify instance)
# Usage: make verify CONTRACT=0xAddress CONTRACT_PATH=contracts/MyContract.sol:MyContract CHAIN_ID=296
# See: https://hedera.com/blog/smart-contract-verification-sourcify-dev-now-supported
verify:
	@if [ -z "$(CONTRACT)" ] || [ -z "$(CONTRACT_PATH)" ]; then \
		echo "Usage: make verify CONTRACT=0xAddress CONTRACT_PATH=contracts/MyContract.sol:MyContract CHAIN_ID=296"; \
		echo ""; \
		echo "Or use yarn commands:"; \
		echo "  yarn verify:testnet 0xAddress contracts/MyContract.sol:MyContract"; \
		echo "  yarn verify:mainnet 0xAddress contracts/MyContract.sol:MyContract"; \
		exit 1; \
	fi
	forge verify-contract $(CONTRACT) $(CONTRACT_PATH) --chain-id $(CHAIN_ID) --verifier sourcify
