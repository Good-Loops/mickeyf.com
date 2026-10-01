import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__parentAccountsLifecycle'; const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = v => ${scope}.state(v); export const useRef = v => ${scope}.ref(v); export const useEffect = (fn, deps) => ${scope}.effect(fn, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    'react-router-dom': 'export const Link = "a";',
    AuthContext: `export const useAuth = () => ${scope}.auth;`,
    ParentRegistration: 'export default "ParentRegistration";',
    parentRegistrationApi: `export const createParentRegistrationApi = () => new Proxy({}, {get: (_target, key) => (...args) => ${scope}.api[key](...args)});`,
    providerClient: `export const getAvailableProviderClients = async () => [{clientKey:'google-web',provider:'google'}]; export const acquireProviderCredential = (...args) => ${scope}.acquire(...args);`,
    apiFetch: 'export const apiFetch = () => { throw new Error("Unexpected real transport"); };',
    apiConfig: 'export const API_BASE = ""; export const LEGACY_PUBLIC_API_PREVIEW = false;',
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: {middlewareMode:true}, ssr: {noExternal:[/^react$/]}, plugins:[{name:'parent-management-lifecycle',enforce:'pre',
        resolveId(source) { const name=source.replaceAll('\\','/').split('/').at(-1).replace(/\.tsx?$/,''); if(Object.hasOwn(mocks,name))return `\0parent-page:${name}`; },
        load(id) { if(id.startsWith('\0parent-page:'))return mocks[id.slice('\0parent-page:'.length)]; },
    }],
});
after(()=>server.close());
const {default:Page}=await server.ssrLoadModule('/ts/pages/ParentAccounts.tsx');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};};
const token=()=>randomBytes(32).toString('base64url');
const nodes=value=>!value||typeof value!=='object'?[]:[value,...[value.props?.children].flat(Infinity).flatMap(nodes)];
const text=value=>typeof value==='string'?value:typeof value==='object'&&value?[value.props?.children].flat(Infinity).map(text).join(' '):'';

function mount(t) {
    const slots=[],effects=[],cancellations=[],withdrawals=[],proofs=[];let cursor=0,dirty=false,tree;
    const child={accountId:randomUUID(),userName:'existing-child'};const challenge={state:token(),nonce:token(),expiresInSeconds:300};
    const acquisition=deferred(); let lists=0;
    const auth={isAuthenticated:true,userName:'parent',loading:false,sessionGeneration:1};
    globalThis[key]={auth,
        state(initial){const slot=slots[cursor++]??={value:initial};return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;dirty=true;}}];},
        ref(initial){return slots[cursor++]??={current:initial};},
        effect(callback,deps){const index=cursor++;const before=slots[index];if(!before||deps.some((v,i)=>!Object.is(v,before.deps[i]))){const slot=slots[index]={deps,cleanup:before?.cleanup};effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});}},
        acquire(...args){acquisition.args=args;return acquisition.promise;},
        api:{config:async()=>({enabled:true,creationEnabled:true,policyVersion:'test',consentVersion:'test',consentText:'Synthetic.',countries:['ZZ']}),
            listChildren:async()=>{lists++;return [child];},beginWithdrawal:async()=>challenge,
            complete(...args){const d=deferred();proofs.push({...d,args});return d.promise;},
            withdraw(...args){const d=deferred();withdrawals.push({...d,args});return d.promise;},cancel:async state=>{cancellations.push(state);}},
    };
    const render=()=>{cursor=0;dirty=false;tree=Page();effects.splice(0).forEach(run=>run());};
    const settle=async()=>{for(let n=0;n<15;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();} assert.equal(dirty,false);};
    const find=predicate=>nodes(tree).find(predicate);const button=label=>find(node=>node.type==='button'&&text(node).includes(label));
    const begin=async()=>{render();await settle();find(node=>node.type==='select').props.onChange({target:{value:child.accountId}});render();
        find(node=>node.type==='input').props.onChange({target:{value:'WITHDRAW AND DELETE'}});render();button('Confirm deletion').props.onClick();await settle();};
    t.after(()=>{slots.forEach(slot=>slot.cleanup?.());delete globalThis[key];});
    return {auth,render,settle,find,button,begin,challenge,acquisition,proofs,withdrawals,cancellations,text:()=>text(tree),lists:()=>lists};
}

for(const stage of ['provider proof','submitted deletion'])test(`late creation completion refreshes the list without cancelling ${stage}`,async t=>{
    const view=mount(t);await view.begin();
    if(stage==='submitted deletion'){
        view.acquisition.resolve('synthetic-token');await view.settle();
        view.proofs[0].resolve({grant:token(),purpose:'withdraw-child',expiresInSeconds:250});await view.settle();
    }
    const signal=stage==='provider proof'?view.acquisition.args[2]:view.withdrawals[0].args[1];
    const creation=deferred();const onCreated=view.find(node=>node.type==='ParentRegistration').props.onCreated;
    const late=creation.promise.then(onCreated);const before=view.lists();creation.resolve();await late;await view.settle();
    assert.ok(view.lists()>before);assert.equal(signal.aborted,false);assert.deepEqual(view.cancellations,[]);
    if(stage==='submitted deletion'){view.withdrawals[0].reject(new Error('response lost'));await view.settle();assert.match(view.text(),/recorded request may still complete/u);}
});

test('session renewal cancels the bound withdrawal and reports its uncertain outcome',async t=>{
    const view=mount(t);await view.begin();view.auth.sessionGeneration++;view.render();await view.settle();
    assert.equal(view.acquisition.args[2].aborted,true);assert.deepEqual(view.cancellations,[view.challenge.state]);
    view.acquisition.resolve('late-token');await view.settle();assert.equal(view.proofs.length,0);
    assert.match(view.text(),/session was refreshed.*submitted deletion may still complete/u);
});
