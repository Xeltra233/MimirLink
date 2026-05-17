const http = require('http');
async function test(msg, history) {
  return new Promise(r => {
    const d = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'range_test',arguments:{message:msg,fakeHistory:history}}});
    const req = http.request({hostname:'localhost',port:8001,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},(res)=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{const j=JSON.parse(b);const inner=JSON.parse(j.result.content[0].text);r(inner.reply||'(空)');}catch(e){r('ERR');}});});
    req.on('error',e=>r('CONN_ERR'));req.write(d);req.end();});
}
const messages=['哟帮主在吗','你谁啊','我叫阿杰，朋友推荐来的','你们这帮派厉害吗','来个厉害的让我见识见识','就这？一般般吧','你别光说不练啊','好吧算你牛','二狗子呢叫出来聊聊','段九德在不在','帮主你写首诗给我听听','哇你还会写诗','那打架呢你能打吗','我不信你打得过我','算了算了我打不过你','帮主你有女朋友吗','姜红颜是谁','她漂亮吗','你怕她吗','哈哈你果然怕老婆','帮主我跟你说个事','有个人老是在群里骂我','他说我是废物','帮主帮我出头呗','谢谢帮主','对了你玩游戏吗','LOL还是原神','你修仙的玩什么游戏','哈哈有道理','帮主晚安'];
(async()=>{
  const history=[];
  for(let i=0;i<messages.length;i++){
    const msg=messages[i];
    const reply=await test(msg,history);
    console.log((i+1)+'. 我: '+msg);
    console.log('   徐缺: '+reply);
    console.log('');
    history.push({role:'user',content:msg});
    history.push({role:'assistant',content:reply});
  }
})();
