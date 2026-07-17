require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.24",
  networks: {
    hederaTestnet: {
      url: process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api",
      accounts: process.env.EVM_PRIVATE_KEY ? [process.env.EVM_PRIVATE_KEY] : [],
      chainId: 296,
    },
  },
};
