const RPC='https://ethereum-rpc.publicnode.com'
const call=async(to,data)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})});return (await r.json()).result}
const USDS='0xdC035D45d973E3EC169d2276DDab16f1e407384F'
for (const s of ['0xca5183FB9997046fbd9bA8113139bf5a5Af122A0','0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d']) {
  const bal=BigInt(await call(USDS,'0x70a08231'+s.slice(2).toLowerCase().padStart(64,'0')))
  const nonce=BigInt(await call(s,'0xaffed0e0'))
  console.log(s,'USDS',(Number(bal/10n**15n)/1000).toLocaleString(),'nonce',nonce.toString())
}
