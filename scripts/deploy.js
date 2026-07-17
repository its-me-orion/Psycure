const hre = require("hardhat");

async function main() {
  const defaultFeeBps = Number(process.env.DEFAULT_PLATFORM_FEE_BPS || 100);
  const Contract = await hre.ethers.getContractFactory("PsycureInvoice");
  const contract = await Contract.deploy(defaultFeeBps);
  await contract.waitForDeployment();
  console.log(`PsycureInvoice deployed to: ${await contract.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
