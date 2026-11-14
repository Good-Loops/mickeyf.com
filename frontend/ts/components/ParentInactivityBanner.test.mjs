import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__inactivityBannerTest', scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState=v=>${scope}.state(v); export const useRef=v=>${scope}.ref(v); export const useEffect=(f,d)=>${scope}.effect(f,d);`,
    'jsx-runtime': 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;',
    'jsx-dev-runtime': 'export const jsxDEV=(type,props)=>({type,props});',
    'react-router-dom': `export const Link='a'; export const useLocation=()=>({pathname:${scope}.path});`,
    AuthContext: `export const useAuth=()=>${scope}.auth;`,
    apiConfig: 'export const API_BASE="";', apiFetch: `export const apiFetch=(...args)=>${scope}.fetch(...args);`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile:`${root}/vite.config.ts`, appType:'custom', logLevel:'silent',
    define: { 'import.meta.env.VITE_ENABLE_CHILD_INACTIVITY_WARNING': '"1"', 'import.meta.env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY': '"1"' }, server:{middlewareMode:true}, ssr:{noExternal:[/^react$/, /^react-router-dom$/]},
    plugins:[{name:'inactivity-banner-test',enforce:'pre', resolveId(source) { const name=source.replaceAll('\\','/').split('/').at(-1).replace(/\.tsx?$/,'');
        if(Object.hasOwn(mocks,name)) return `\0banner:${name}`; }, load(id) { if(id.startsWith('\0banner:')) return mocks[id.slice(8)]; } }],
});
after(()=>server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/ParentInactivityBanner.tsx');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const text=value=>typeof value==='string'?value:typeof value==='object'&&value?[value.props?.children].flat(Infinity).map(text).join(' '):'';
function mount(t) {
    const slots=[], effects=[], requests=[]; let cursor=0, dirty=false, tree, generation=1;
    const auth={isAuthenticated:true,userName:'parent',sessionGeneration:1,captureAccountAction:()=>0,captureSessionGeneration:()=>generation};
    globalThis[key]={auth,path:'/',fetch(...args){const result=deferred();requests.push({...result,args});return result.promise;},
        state(initial){const s=slots[cursor++]??={value:initial};return [s.value,value=>{if(!Object.is(s.value,value)){s.value=value;dirty=true;}}];},
        ref(initial){return slots[cursor++]??={current:initial};},
        effect(fn,deps){const i=cursor++,before=slots[i];if(!before||deps.some((v,n)=>!Object.is(v,before.deps[n]))){const s=slots[i]={deps,cleanup:before?.cleanup};effects.push(()=>{s.cleanup?.();s.cleanup=fn();});}},
    };
    const render=()=>{cursor=0;dirty=false;tree=Component();effects.splice(0).forEach(run=>run());};
    const settle=async()=>{for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();}};
    t.after(()=>{slots.forEach(s=>s.cleanup?.());delete globalThis[key];});
    return {auth,requests,render,settle,text:()=>text(tree),invalidate:()=>{generation++;},navigate:path=>{globalThis[key].path=path;render();}};
}

test('a pending warning shows a generic link and is refreshed after visiting parent accounts',async t=>{
    const view=mount(t);view.render();await view.settle();assert.equal(view.requests[0].args[0],'/auth/child-inactivity/pending');
    view.requests[0].resolve({ok:true,json:async()=>({pending:true})});await view.settle();assert.match(view.text(),/child account needs your attention/u);
    view.navigate('/parent-accounts');await view.settle();assert.equal(view.text(),'');
    view.navigate('/');await view.settle();view.requests[1].resolve({ok:true,json:async()=>({pending:false})});await view.settle();assert.equal(view.text(),'');
});
test('a stale session or malformed response never displays a warning',async t=>{
    const view=mount(t);view.render();await view.settle();view.invalidate();view.requests[0].resolve({ok:true,json:async()=>({pending:true})});
    await view.settle();assert.equal(view.text(),'');
});
