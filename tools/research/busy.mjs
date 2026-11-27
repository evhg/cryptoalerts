const RPC='https://ethereum-rpc.publicnode.com'
const rpc=async(method,params)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result}
const pools={
 'univ3 USDC/WETH 0.05%':'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
 'univ3 WETH/USDT 0.05%':'0x11b815efB8f581194ae79006d24E0d814B7697F6',
 'univ2 USDC/WETH':'0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
 'univ2 WETH/USDT':'0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
 'univ3 WBTC/WETH 0.3%':'0xCBCdF9626bC03E24f779434178A73a0B4bad62eD',
 'univ4 PoolManager':'0x000000000004444c5dc75cB358380D2e3dE08A90',
 'univ3 USDC/USDT 0.01%':'0x3416cF6C708Da44DB2624D63ea0AAef7113527C6',
 'curve stUSDS/USDS':'0x2C7C98A3b1582D83c43987202aEFf638312478aE',
}
const head=Number(await rpc('eth_blockNumber',[]))
const N=100, from=head-N+1
for(const [name,a] of Object.entries(pools)){
  const logs=await rpc('eth_getLogs',[{address:a,fromBlock:'0x'+from.toString(16),toBlock:'0x'+head.toString(16)}])
  const blocks=new Set(logs.map(l=>l.blockNumber))
  console.log(name.padEnd(24),a,'blocks touched',blocks.size,'/',N)
}
