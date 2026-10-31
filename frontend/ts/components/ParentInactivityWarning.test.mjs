import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__parentInactivityWarningTest'; const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = v => ${scope}.state(v); export const useRef = v => ${scope}.ref(v); export const useEffect = (fn, deps) => ${scope}.effect(fn, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    apiConfig: 'export const API_BASE = "";',
    apiFetch: `export const apiFetch = (...args) => ${scope}.fetch(...args);`,
    pageOwnership: `export const capturePageOwnership = () => () => ${scope}.pageCurrent;`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType:'custom', logLevel:'silent',
    server:{middlewareMode:true}, ssr:{noExternal:[/^react$/]}, plugins:[{name:'inactivity-warning-test',enforce:'pre',
        resolveId(source) { const name=source.replaceAll('\\','/').split('/').at(-1).replace(/\.tsx?$/,''); if(Object.hasOwn(mocks,name)) return `\0warning:${name}`; },
        load(id) { if(id.startsWith('\0warning:')) return mocks[id.slice('\0warning:'.length)]; },
    }],
});
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/ParentInactivityWarning.tsx');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
const text = value => typeof value === 'string' ? value : typeof value === 'object' && value ? [value.props?.children].flat(Infinity).map(text).join(' ') : '';
const reply = value => ({ ok:true, json:async () => value });

function mount(t) {
    const slots=[], effects=[], requests=[]; let cursor=0, dirty=false, tree;
    const childAccountId=randomUUID(), warningId=randomUUID();
    let generation=1, refreshKey=0, selectionCurrent=true;
    const selectionIsCurrent=()=>selectionCurrent, captureSessionGeneration=()=>generation, captureAccountAction=()=>0;
    globalThis[key]={pageCurrent:true, fetch(...args){const request=deferred();requests.push({...request,args});return request.promise;},
        state(initial){const slot=slots[cursor++]??={value:initial};return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;dirty=true;}}];},
        ref(initial){return slots[cursor++]??={current:initial};},
        effect(callback,deps){const index=cursor++;const before=slots[index];if(!before||deps.some((v,i)=>!Object.is(v,before.deps[i]))){const slot=slots[index]={deps,cleanup:before?.cleanup};effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});}},
    };
    const render=()=>{cursor=0;dirty=false;tree=Component({childAccountId,sessionGeneration:1,refreshKey,selectionIsCurrent,captureSessionGeneration,captureAccountAction});effects.splice(0).forEach(run=>run());};
    const settle=async()=>{for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();}assert.equal(dirty,false);};
    const button=label=>nodes(tree).find(node=>node.type==='button'&&text(node).includes(label));
    const warning={warningId,acknowledged:false,notice:{version:'test-version',en:'Exact English warning.',ptBR:'Aviso exato em português.'}};
    t.after(()=>{slots.forEach(slot=>slot.cleanup?.());delete globalThis[key];});
    return {render,settle,requests,button,warning,childAccountId,text:()=>text(tree),changeSelection:()=>{selectionCurrent=false;},changeSession:()=>{generation++;},refresh:()=>{refreshKey++;render();}};
}

test('renders the exact server notice and acknowledges only the selected warning',async t=>{
    const view=mount(t);view.render();await view.settle();
    assert.equal(view.requests[0].args[0],'/auth/child-inactivity/warning');
    assert.deepEqual(JSON.parse(view.requests[0].args[1].body),{childAccountId:view.childAccountId});
    view.requests[0].resolve(reply({warning:view.warning}));await view.settle();
    assert.match(view.text(),/Exact English warning/u);assert.match(view.text(),/Aviso exato em português/u);
    view.button('I have read').props.onClick();await view.settle();
    assert.deepEqual(JSON.parse(view.requests[1].args[1].body),{childAccountId:view.childAccountId,warningId:view.warning.warningId,acknowledge:true});
    assert.equal(view.requests[1].args[0],'/auth/child-inactivity/acknowledge');
    assert.doesNotMatch(view.text(),/You acknowledged/u);
    view.requests[1].resolve(reply({acknowledged:true}));await view.settle();assert.match(view.text(),/You acknowledged/u);
});

test('malformed warning or unconfirmed acknowledgment is never displayed as success',async t=>{
    const view=mount(t);view.render();await view.settle();view.requests[0].resolve(reply({warning:{...view.warning,notice:{}}}));await view.settle();
    assert.match(view.text(),/could not check/u);assert.equal(view.button('I have read'),undefined);
    view.button('Try again').props.onClick();await view.settle();view.requests[1].resolve(reply({warning:view.warning}));await view.settle();
    view.button('I have read').props.onClick();await view.settle();view.requests[2].resolve(reply({acknowledged:false}));await view.settle();
    assert.match(view.text(),/could not check/u);assert.doesNotMatch(view.text(),/You acknowledged/u);
});

for (const stale of ['selection','session']) test(`a late warning or acknowledgment cannot update a stale ${stale}`,async t=>{
    const view=mount(t);view.render();await view.settle();view.requests[0].resolve(reply({warning:view.warning}));await view.settle();
    view.button('I have read').props.onClick();await view.settle();
    if(stale==='selection')view.changeSelection();else view.changeSession();
    assert.equal(view.requests[1].args[1].isCurrent(),false);
    view.requests[1].resolve(reply({acknowledged:true}));await view.settle();assert.doesNotMatch(view.text(),/You acknowledged/u);
});

test('keeping an account refreshes the warning instead of leaving a stale acknowledgment visible',async t=>{
    const view=mount(t);view.render();await view.settle();view.requests[0].resolve(reply({warning:view.warning}));await view.settle();
    view.refresh();await view.settle();assert.doesNotMatch(view.text(),/Exact English warning/u);
    view.requests[1].resolve(reply({warning:null}));await view.settle();assert.doesNotMatch(view.text(),/Exact English warning/u);
});

test('a late warning response after changing selection cannot expose the old child notice',async t=>{
    const view=mount(t);view.render();await view.settle();view.changeSelection();view.requests[0].resolve(reply({warning:view.warning}));await view.settle();
    assert.doesNotMatch(view.text(),/Exact English warning/u);assert.equal(view.button('I have read'),undefined);
});
