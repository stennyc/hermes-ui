import{o as e}from"./rolldown-runtime-C_JxhDyB.js";import{a as t,i as n}from"./react-vendor-Dkbp8xwg.js";import{t as r}from"./preload-helper-HclGiUj8.js";import{n as i}from"./bundle-mjs-B_AA55HL.js";import{t as a}from"./lib-CvJYUEFg.js";import"./shiki-highlighter-B_mhcfFt.js";import{i as o}from"./shiki-plain-C_EcoVNz.js";import{r as s,t as c}from"./diff-lines-CJ_2YASo.js";import{a as l,i as u,n as d,o as f,r as p}from"./dist-BC9n3o0f.js";var m=e(t(),1),h=e(n(),1),g=Object.prototype.hasOwnProperty;function _(e,t,n){for(n of e.keys())if(v(n,t))return n}function v(e,t){var n,r,i;if(e===t)return!0;if(e&&t&&(n=e.constructor)===t.constructor){if(n===Date)return e.getTime()===t.getTime();if(n===RegExp)return e.toString()===t.toString();if(n===Array){if((r=e.length)===t.length)for(;r--&&v(e[r],t[r]););return r===-1}if(n===Set){if(e.size!==t.size)return!1;for(r of e)if(i=r,i&&typeof i==`object`&&(i=_(t,i),!i)||!t.has(i))return!1;return!0}if(n===Map){if(e.size!==t.size)return!1;for(r of e)if(i=r[0],i&&typeof i==`object`&&(i=_(t,i),!i)||!v(r[1],t.get(i)))return!1;return!0}if(n===ArrayBuffer)e=new Uint8Array(e),t=new Uint8Array(t);else if(n===DataView){if((r=e.byteLength)===t.byteLength)for(;r--&&e.getInt8(r)===t.getInt8(r););return r===-1}if(ArrayBuffer.isView(e)){if((r=e.byteLength)===t.byteLength)for(;r--&&e[r]===t[r];);return r===-1}if(!n||typeof e==`object`){for(n in r=0,e)if(g.call(e,n)&&++r&&!g.call(t,n)||!(n in t)||!v(e[n],t[n]))return!1;return Object.keys(t).length===r}}return e!==e&&t!==t}var y=e=>{let t=(0,h.useRef)(e);return e!==t.current&&!v(e,t.current)&&(t.current=e),t.current},b=(e,t,n)=>{let r=Date.now();clearTimeout(t.current.timeoutId);let i=Math.max(0,t.current.nextAllowedTime-r);t.current.timeoutId=setTimeout(()=>{e().catch(console.error),t.current.nextAllowedTime=r+n},i)},x=`plaintext`,S=e=>e==null?[]:Array.isArray(e)?e:[e],C=e=>e==null?null:typeof e==`string`?`s:${e}`:`o:${e.name}::${e.scopeName}`,w=e=>{let t=new Set,n=[];for(let r of e){let e=C(r);e==null||t.has(e)||(t.add(e),n.push(r))}return n},T=(e,t)=>e==null?!1:typeof e==`string`?e in t:typeof e.name==`string`&&typeof e.scopeName==`string`,E=(e,t)=>u(e)||t.includes(e)?e:x,D=(e,t,n,r)=>{let i=S(t),a=S(r),o=[...i,...a],s=x,c;if(e==null||typeof e==`string`&&!e.trim())return{languageId:s,langsToLoad:w([...a,...i])};if(typeof e==`object`)s=e.name,c=e;else{let t=e.toLowerCase(),r=e=>e?.toLowerCase()===t,i=o.find(e=>typeof e==`object`&&!!e&&!!(r(e.name)||r(e.scopeName)||r(e.scopeName?.split(`.`).pop())||e.aliases?.some(r)||e.fileTypes?.some(r)));i?(s=i.name||e,c=i):n?.[e]?(s=n[e],c=n[e]):(s=e,c=e)}return{languageId:s,langsToLoad:w([c,...a,...i])}},O=e=>typeof e==`object`&&!!e&&`tokenColors`in e&&Array.isArray(e.tokenColors);function k(e){let t=O(e),n=typeof e==`object`&&!!e&&!t,r=typeof e==`object`&&!!e&&!t&&Object.entries(e).some(([e,t])=>e.trim()!==``&&(typeof t==`string`&&t.trim()!==``||O(t)));return n?{isMultiTheme:!0,themeId:r?`multi-${Object.values(e).map(e=>(typeof e==`string`?e:e?.name)||`custom`).sort().join(`-`)}`:`multi-default`,multiTheme:r?e:null,themesToLoad:r?Object.values(e):[]}:{isMultiTheme:!1,themeId:typeof e==`string`?e:e?.name||`custom`,singleTheme:e,themesToLoad:[e]}}function A(e=1){return{name:`react-shiki:line-numbers`,code(t){if(this.addClassToHast(t,`has-line-numbers`),this.addClassToHast(t,`rs-has-line-numbers`),e!==1){let n=t.properties?.style||``,r=n?`${n}; --line-start: ${e}`:`--line-start: ${e}`;t.properties={...t.properties,style:r}}},line(e){return this.addClassToHast(e,`line-numbers`),this.addClassToHast(e,`rs-line-number`),e}}}var j={light:`github-light`,dark:`github-dark`},M=(e,t)=>e.isMultiTheme?{themes:e.multiTheme??j,defaultColor:t.defaultColor,cssVariablePrefix:t.cssVariablePrefix}:{theme:e.singleTheme??j.dark},N=e=>{let t=[...e.transformers||[]];return e.showLineNumbers&&t.push(A(e.startingLineNumber)),t},P=({languageId:e,resolvedTheme:t,options:n})=>{let{defaultColor:r,cssVariablePrefix:i,showLineNumbers:a,startingLineNumber:o,transformers:s,...c}=n;return{lang:e,...M(t,n),...c,transformers:N(n)}},F=(e,t,n)=>{let r=n.getBundledLanguages();return p(e,t).flatMap(e=>r[e]??[])},I=(e,t,n,r={},i)=>{let[o,s]=(0,h.useState)(null),c=y(t),l=y(n),u=y(r),{languageId:d,langsToLoad:f}=(0,h.useMemo)(()=>D(c,u.customLanguages,u.langAlias,u.preloadLanguages),[c,u.customLanguages,u.preloadLanguages,u.langAlias]),p=(0,h.useMemo)(()=>k(l),[l]),{themesToLoad:g}=p,_=(0,h.useRef)({nextAllowedTime:0,timeoutId:void 0}),v=(0,h.useMemo)(()=>P({languageId:d,resolvedTheme:p,options:u}),[d,p,u]);return(0,h.useEffect)(()=>{let t=!0,n=async()=>{if(!d)return;let n=u.highlighter?u.highlighter:await i(f,g,u.engine);if(!u.highlighter){let t=F(e,d,n);t.length>0&&await n.loadLanguage(...t)}let r=E(d,n.getLoadedLanguages()),o={...v,lang:r};if(t){let t=u.outputFormat===`html`?n.codeToHtml(e,o):a(n.codeToHast(e,o),{jsx:m.jsx,jsxs:m.jsxs,Fragment:m.Fragment});s(t)}},{delay:r}=u;return r?b(n,_,r):n().catch(console.error),()=>{t=!1,clearTimeout(_.current.timeoutId)}},[e,v,u.delay,u.highlighter,f,g]),o};function L(e,{insertAt:t}={}){if(!e||typeof document>`u`)return;let n=document.head||document.getElementsByTagName(`head`)[0],r=document.createElement(`style`);r.type=`text/css`,t===`top`&&n.firstChild?n.insertBefore(r,n.firstChild):n.appendChild(r),r.styleSheet?r.styleSheet.cssText=e:r.appendChild(document.createTextNode(e))}L(`@layer base {
  .rs-root {
    position: relative;
  }
  .rs-default-styles pre {
    overflow: auto;
    border-radius: 0.5rem;
    padding-left: 1.5rem;
    padding-right: 1.5rem;
    padding-top: 1.25rem;
    padding-bottom: 1.25rem;
  }
  .rs-language-label {
    position: absolute;
    right: 0.75rem;
    top: 0.5rem;
    font-family: monospace;
    font-size: 0.75rem;
    letter-spacing: -0.05em;
    color: rgba(107, 114, 128, 0.85);
  }
}
`),L(`@layer base {
  .line-numbers::before,
  .rs-line-number::before {
    counter-increment: line-number;
    content: counter(line-number);
    display: inline-flex;
    justify-content: flex-end;
    align-items: flex-start;
    box-sizing: content-box;
    min-width: var(--rs-line-numbers-width, 2ch);
    padding-left: var(--rs-line-numbers-padding-left, 2ch);
    padding-right: var(--rs-line-numbers-padding-right, 2ch);
    color: var(--rs-line-numbers-foreground, rgba(107, 114, 128, 0.6));
    font-size: var(--rs-line-numbers-font-size, inherit);
    font-weight: var(--rs-line-numbers-font-weight, inherit);
    line-height: var(--rs-line-numbers-line-height, inherit);
    font-family: var(--rs-line-numbers-font-family, inherit);
    opacity: var(--rs-line-numbers-opacity, 1);
    user-select: none;
    pointer-events: none;
  }
  .has-line-numbers,
  .rs-has-line-numbers {
    counter-reset: line-number calc(var(--line-start, 1) - 1);
    --rs-line-numbers-foreground: var(--line-numbers-foreground, rgba(107, 114, 128, 0.5));
    --rs-line-numbers-width: var(--line-numbers-width, 2ch);
    --rs-line-numbers-padding-left: var(--line-numbers-padding-left, 0ch);
    --rs-line-numbers-padding-right: var(--line-numbers-padding-right, 2ch);
    --rs-line-numbers-font-size: var(--line-numbers-font-size, inherit);
    --rs-line-numbers-font-weight: var(--line-numbers-font-weight, inherit);
    --rs-line-numbers-line-height: var(--line-numbers-line-height, inherit);
    --rs-line-numbers-font-family: var(--line-numbers-font-family, inherit);
    --rs-line-numbers-opacity: var(--line-numbers-opacity, 1);
  }
}
`);var R=e=>(0,h.forwardRef)(({language:t,theme:n,delay:r,transformers:a,defaultColor:o,cssVariablePrefix:s,addDefaultStyles:c=!0,style:l,langStyle:u,className:d,langClassName:f,showLanguage:p=!0,showLineNumbers:h=!1,startingLineNumber:g=1,children:_,as:v=`pre`,customLanguages:y,preloadLanguages:b,...x},S)=>{let C={delay:r,transformers:a,customLanguages:y,preloadLanguages:b,showLineNumbers:h,defaultColor:o,cssVariablePrefix:s,startingLineNumber:g,...x},w=typeof t==`object`?t.name||null:t?.trim()||null,T=e(_,t,n,C),E=typeof T==`string`;return(0,m.jsxs)(v,{ref:S,"data-testid":`shiki-container`,className:i(`rs-root`,`not-prose`,c&&`rs-default-styles`,d),style:l,id:`shiki-container`,children:[p&&w?(0,m.jsx)(`span`,{className:i(`rs-language-label`,f),style:u,id:`language-label`,children:w}):null,E?(0,m.jsx)(`div`,{dangerouslySetInnerHTML:{__html:T}}):T]})});async function z(e,t,n){return await d({langs:e.filter(e=>T(e,f)),themes:t,engine:n??l(r(()=>import(`./wasm-BnjxR4X6.js`),[],import.meta.url))})}var B=(e,t,n,r={})=>I(e,t,n,r,z);R(B);function V({language:e,lines:t}){return B((0,h.useMemo)(()=>t.map(e=>e.text).join(`
`),[t]),e,o,{defaultColor:`light-dark()`,transformers:(0,h.useMemo)(()=>[s(t.map(e=>e.kind))],[t])})??(0,m.jsx)(c,{lines:t})}export{V as default};