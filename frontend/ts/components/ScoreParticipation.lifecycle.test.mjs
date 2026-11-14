import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key='__scoreParticipationLifecycle', scope=`globalThis.${key}`;
const mocks={
    react:`export const useState=v=>${scope}.state(v); export const useRef=v=>${scope}.ref(v); export const useEffect=(fn,deps)=>${scope}.effect(fn,deps);`,
    'jsx-runtime':'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;',
    'jsx-dev-runtime':'export const jsxDEV=(type,props)=>({type,props});',
    parentRegistrationApi:`export const createParentRegistrationApi=()=>new Proxy({}, {get:(_t,key)=>(...args)=>${scope}.api[key](...args)});`,
    providerClient:`export const getAvailableProviderClients=async()=>[{clientKey:'apple-web',provider:'apple'}]; export const acquireProviderCredential=(...args)=>${scope}.acquire(...args);`,
    apiFetch:'export const apiFetch=()=>{throw new Error("Unexpected real transport")};',
    apiConfig:'export const API_BASE="";', PrivacyNoticeLink:'export default "PrivacyNoticeLink";',
};
const root=fileURLToPath(new URL('../../',import.meta.url));
const server=await createViteTestServer({root,configFile:`${root}/vite.config.ts`,appType:'custom',logLevel:'silent',
    server:{middlewareMode:true},ssr:{noExternal:[/^react$/]},plugins:[{name:'score-page-lifecycle',enforce:'pre',
        resolveId(source){const name=source.replaceAll('\\','/').split('/').at(-1).replace(/\.tsx?$/,'');if(Object.hasOwn(mocks,name))return `\0score-page:${name}`;},
        load(id){if(id.startsWith('\0score-page:'))return mocks[id.slice('\0score-page:'.length)];}}]},);
after(()=>server.close());
const {default:Component}=await server.ssrLoadModule('/ts/components/ScoreParticipation.tsx');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const nodes=value=>!value||typeof value!=='object'?[]:[value,...[value.props?.children].flat(Infinity).flatMap(nodes)];
const text=value=>typeof value==='string'?value:typeof value==='object'&&value?[value.props?.children].flat(Infinity).map(text).join(' '):'';

test('child selection or synchronous session change cancels pending score approval before sending',async t=>{
    for(const cause of ['selection','session']){
        const slots=[],effects=[],proofs=[],cancellations=[],acquisition=deferred();let cursor=0,dirty=false,tree,current=true,session=4;
        const props={childAccountId:'synthetic-child',authenticated:true,accountKey:'parent',sessionGeneration:4,
            selectionIsCurrent:()=>current,captureSessionGeneration:()=>session};
        globalThis[key]={state(initial){const slot=slots[cursor++]??={value:initial};return [slot.value,next=>{
            const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;dirty=true;}}];},
            ref(initial){return slots[cursor++]??={current:initial};},effect(fn,deps){const index=cursor++,before=slots[index];
                if(!before||deps.some((value,i)=>!Object.is(value,before.deps[i]))){const slot=slots[index]={deps,cleanup:before?.cleanup};effects.push(()=>{slot.cleanup?.();slot.cleanup=fn();});}},
            acquire:()=>acquisition.promise,api:{scoreConfig:async()=>({enabled:true,policyVersion:'v1',consentVersion:'v1',consentText:'Synthetic',privacyNoticeUrl:'https://mickeyf.com/privacy'}),
                scoreStatus:async()=>({visibility:'private',canPublish:true}),beginScorePublication:async()=>({state:'synthetic-state'}),
                complete:(...args)=>{proofs.push(args);return Promise.resolve({grant:'synthetic',purpose:'publish-scores'});},
                publishScores:()=>assert.fail('stale approval must not publish'),cancel:async state=>{cancellations.push(state);}}};
        const render=()=>{cursor=0;dirty=false;tree=Component(props);effects.splice(0).forEach(run=>run());};
        const settle=async()=>{for(let n=0;n<10;n++){await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;render();}assert.fail('hooks did not settle');};
        render();await settle();nodes(tree).find(node=>node.type==='input').props.onChange({target:{checked:true}});render();
        nodes(tree).find(node=>node.type==='button'&&text(node).includes('Join leaderboards')).props.onClick();await settle();
        if(cause==='selection')current=false;else session++;
        acquisition.resolve('synthetic-proof');await settle();
        assert.equal(proofs.length,0,cause);assert.deepEqual(cancellations,['synthetic-state'],cause);
        assert.equal(nodes(tree).find(node=>node.type==='button'&&text(node).includes('Join leaderboards')).props.disabled,false,
            'a still-mounted page is not stranded busy');
        slots.forEach(slot=>slot.cleanup?.());delete globalThis[key];
    }
});

test('a pending refresh cannot invalidate an in-flight removal or hide its result',async()=>{
    const slots=[],effects=[],refresh=deferred(),removal=deferred();let cursor=0,dirty=false,tree,loads=0;
    const props={childAccountId:'synthetic-child',authenticated:true,accountKey:'parent',sessionGeneration:4};
    globalThis[key]={state(initial){const slot=slots[cursor++]??={value:initial};return [slot.value,next=>{
        const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;dirty=true;}}];},
        ref(initial){return slots[cursor++]??={current:initial};},effect(fn,deps){const index=cursor++,before=slots[index];
            if(!before||deps.some((value,i)=>!Object.is(value,before.deps[i]))){const slot=slots[index]={deps,cleanup:before?.cleanup};effects.push(()=>{slot.cleanup?.();slot.cleanup=fn();});}},
        api:{scoreConfig:async()=>({enabled:true,policyVersion:'v1',consentVersion:'v1',consentText:'Synthetic',privacyNoticeUrl:'https://mickeyf.com/privacy'}),
            scoreStatus:()=>++loads===2?refresh.promise:Promise.resolve({visibility:'public',canPublish:true}),
            withdrawScores:()=>removal.promise,cancel:async()=>{}}};
    const render=()=>{cursor=0;dirty=false;tree=Component(props);effects.splice(0).forEach(run=>run());};
    const settle=async()=>{for(let n=0;n<10;n++){await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;render();}assert.fail('hooks did not settle');};
    const button=label=>nodes(tree).find(node=>node.type==='button'&&text(node).includes(label));
    try {
        render();await settle();
        button('Refresh leaderboard choice').props.onClick();render();await settle();
        button('Remove public entries').props.onClick();await settle();
        refresh.resolve({visibility:'public',canPublish:true});await settle();
        removal.resolve({});await settle();
        assert.ok(nodes(tree).some(node=>text(node).includes('Public entries have been removed. Your account and private scores are kept.')));
    } finally { slots.forEach(slot=>slot.cleanup?.());delete globalThis[key]; }
});
