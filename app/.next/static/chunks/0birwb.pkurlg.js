(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,49311,e=>{"use strict";var t=e.i(71645);function r(e,t,r){return Math.min(r,Math.max(t,e))}function a(e,t){return t?Math.round(e/t)*t:e}function n(e){let t=e.item(0),r=e.item(1);return t&&r?Math.hypot(t.clientX-r.clientX,t.clientY-r.clientY):0}function i(e){return{x:e.clientX,y:e.clientY}}function o(e){let t=0,r=0;for(let a=0;a<e.length;a+=1){let n=e.item(a);n&&(t+=n.clientX,r+=n.clientY)}let a=Math.max(1,e.length);return{x:t/a,y:r/a}}function l(e,t){return e instanceof HTMLElement&&(!!(t&&e.closest(t))||!!e.closest("a[href],button,input,select,textarea,summary,[contenteditable='true'],[role='button'],[role='link'],[role='menuitem'],[role='tab'],[data-touch-ignore],[data-no-swipe]"))}e.s(["isEditableTouchTarget",0,function(e){return e instanceof HTMLElement&&!!e.closest("input, textarea, select, [contenteditable='true']")},"useDoubleTap",0,function(e,r,a={}){let n=(0,t.useRef)(r),o=(0,t.useRef)(a);(0,t.useEffect)(()=>{n.current=r,o.current=a},[r,a]),(0,t.useEffect)(()=>{let t=e.current;if(!t||a.disabled)return;let r=!1,d=null,s=e=>{e.touches.length>1&&(r=!0)},c=e=>{let t=o.current;if(r){0===e.touches.length&&(r=!1);return}if(1!==e.changedTouches.length||e.touches.length>0||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector))return;let a=Date.now(),s=i(e.changedTouches[0]),c=t.maxDelayMs??280,u=t.maxDistancePx??28;if(d&&a-d.time<=c&&Math.hypot(s.x-d.x,s.y-d.y)<=u){e.preventDefault(),d=null,n.current();return}d={time:a,...s}},u=()=>{d=null,r=!1};return t.addEventListener("touchstart",s,{passive:!0}),t.addEventListener("touchend",c,{passive:!1}),t.addEventListener("touchcancel",u,{passive:!0}),()=>{t.removeEventListener("touchstart",s),t.removeEventListener("touchend",c),t.removeEventListener("touchcancel",u)}},[e,a.disabled,a.effectKey])},"useMultiTouchSwipe",0,function(e,r){let a=(0,t.useRef)(r);(0,t.useEffect)(()=>{a.current=r},[r]),(0,t.useEffect)(()=>{let t=e.current;if(!t||r.disabled)return;let n=null,i=null,d=!1,s=()=>{n=null,i=null,d=!1},c=e=>{let t=a.current;e.touches.length!==t.fingers||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)?s():(i=n=o(e.touches),d=!0)},u=e=>{let t=a.current;d&&e.touches.length===t.fingers&&(i=o(e.touches),e.preventDefault())},h=e=>{let t=a.current;if(!d||!n||!i||e.touches.length>=t.fingers)return;let r=i.x-n.x,o=i.y-n.y,l=Math.abs(r),c=Math.abs(o),u=t.minDistancePx??64,h=t.maxCrossAxisPx??72;(s(),l>=u&&c<=h)?r<0?t.onSwipeLeft?.():t.onSwipeRight?.():c>=u&&l<=h&&(o<0?t.onSwipeUp?.():t.onSwipeDown?.())};return t.addEventListener("touchstart",c,{passive:!0}),t.addEventListener("touchmove",u,{passive:!1}),t.addEventListener("touchend",h,{passive:!0}),t.addEventListener("touchcancel",s,{passive:!0}),()=>{t.removeEventListener("touchstart",c),t.removeEventListener("touchmove",u),t.removeEventListener("touchend",h),t.removeEventListener("touchcancel",s)}},[e,r.disabled,r.effectKey])},"usePinchZoom",0,function(e,i){let o=(0,t.useRef)(i.value),d=(0,t.useRef)(i.onChange),s=(0,t.useRef)(i);(0,t.useEffect)(()=>{o.current=i.value,d.current=i.onChange,s.current=i},[i]),(0,t.useEffect)(()=>{let t=e.current;if(!t||i.disabled)return;let c=!1,u=0,h=o.current,p=e=>{let t=s.current;2!==e.touches.length||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)||(u=n(e.touches),h=o.current,c=u>0)},m=e=>{if(!c||2!==e.touches.length||u<=0)return;let t=n(e.touches);if(t<=0)return;e.preventDefault();let i=s.current,o=r(a(t/u*h,i.step??.01),i.min,i.max);d.current(o)},g=e=>{e.touches.length<2&&(c=!1,u=0)};return t.addEventListener("touchstart",p,{passive:!0}),t.addEventListener("touchmove",m,{passive:!1}),t.addEventListener("touchend",g,{passive:!0}),t.addEventListener("touchcancel",g,{passive:!0}),()=>{t.removeEventListener("touchstart",p),t.removeEventListener("touchmove",m),t.removeEventListener("touchend",g),t.removeEventListener("touchcancel",g)}},[e,i.disabled,i.effectKey])},"useSwipeGesture",0,function(e,r){let a=(0,t.useRef)(r);(0,t.useEffect)(()=>{a.current=r},[r]),(0,t.useEffect)(()=>{let t=e.current;if(!t||r.disabled)return;let n=null,o=!1,d=e=>{let t=a.current;if(1!==e.touches.length||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)){o=!1,n=null;return}o=!0,n=i(e.touches[0])},s=e=>{if(!o||!n||1!==e.changedTouches.length)return;let t=a.current,r=i(e.changedTouches[0]),l=r.x-n.x,d=r.y-n.y,s=Math.abs(l),c=Math.abs(d),u=t.minDistancePx??64,h=t.maxCrossAxisPx??72;(o=!1,n=null,s>=u&&c<=h)?l<0?t.onSwipeLeft?.():t.onSwipeRight?.():c>=u&&s<=h&&(d<0?t.onSwipeUp?.():t.onSwipeDown?.())},c=()=>{o=!1,n=null};return t.addEventListener("touchstart",d,{passive:!0}),t.addEventListener("touchend",s,{passive:!0}),t.addEventListener("touchcancel",c,{passive:!0}),()=>{t.removeEventListener("touchstart",d),t.removeEventListener("touchend",s),t.removeEventListener("touchcancel",c)}},[e,r.disabled,r.effectKey])},"useTrackpadPinch",0,function(e,n){let i=(0,t.useRef)(n.value),o=(0,t.useRef)(n.onChange),d=(0,t.useRef)(n);(0,t.useEffect)(()=>{i.current=n.value,o.current=n.onChange,d.current=n},[n]),(0,t.useEffect)(()=>{let t=e.current;if(!t||n.disabled)return;let s=e=>{let t=d.current;if(!e.ctrlKey&&!e.metaKey||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector))return;if(e.preventDefault(),t.multiplicative){let a=t.step??.01,n=r(Math.exp(-e.deltaY*a),.8,1.25),l=r(i.current*n,t.min,t.max);o.current(l);return}let n=t.step??.04,s=e.deltaY<0?1:-1,c=r(a(i.current+s*n,n),t.min,t.max);o.current(c)};return t.addEventListener("wheel",s,{passive:!1}),()=>t.removeEventListener("wheel",s)},[e,n.disabled,n.effectKey])}])},55436,e=>{"use strict";let t=(0,e.i(75254).default)("search",[["path",{d:"m21 21-4.34-4.34",key:"14j7rj"}],["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}]]);e.s(["Search",0,t],55436)},10980,e=>{"use strict";let t=(0,e.i(75254).default)("book-open",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);e.s(["BookOpen",0,t],10980)},73708,e=>{"use strict";let t=(0,e.i(75254).default)("image",[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",ry:"2",key:"1m3agn"}],["circle",{cx:"9",cy:"9",r:"2",key:"af1f0g"}],["path",{d:"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",key:"1xmnt7"}]]);e.s(["Image",0,t],73708)},47919,e=>{"use strict";let t=(0,e.i(75254).default)("highlighter",[["path",{d:"m9 11-6 6v3h9l3-3",key:"1a3l36"}],["path",{d:"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",key:"14a9rk"}]]);e.s(["Highlighter",0,t],47919)},31278,e=>{"use strict";var t=e.i(17521);e.s(["Loader2",()=>t.default])},63059,e=>{"use strict";let t=(0,e.i(75254).default)("chevron-right",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);e.s(["ChevronRight",0,t],63059)},64659,e=>{"use strict";let t=(0,e.i(75254).default)("chevron-down",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);e.s(["ChevronDown",0,t],64659)},86527,e=>{"use strict";async function t(e,t){let r=await fetch(`/api/custom${e}`,{credentials:"include",cache:"no-store",...t,headers:{...t?.body instanceof FormData?{}:{"Content-Type":"application/json"},...t?.headers||{}}});if(!r.ok){let e=`HTTP ${r.status}`;try{let t=await r.json();t&&"string"==typeof t.detail?e=t.detail:t&&Array.isArray(t.detail)&&(e=t.detail.map(e=>`${(e.loc||[]).filter(e=>"body"!==e).join(".")}: ${e.msg||"invalid"}`).join("; ")||e)}catch{}throw Error(e)}if(204!==r.status)return r.json()}async function r(){return t("/tree")}async function a(e){return(await t(`/nodes/${encodeURIComponent(e)}`)).node}async function n(e,r){return(await t("/folders",{method:"POST",body:JSON.stringify({name:e,parentId:r})})).node}async function i(e,r,a=""){return(await t("/docs",{method:"POST",body:JSON.stringify({title:e,parentId:r,bodyHtml:a})})).node}async function o(e){return t("/items",{method:"POST",body:JSON.stringify(e)})}async function l(e,r){return(await t(`/nodes/${encodeURIComponent(e)}`,{method:"PATCH",body:JSON.stringify(r)})).node}async function d(e){return(await t(`/nodes/${encodeURIComponent(e)}`,{method:"DELETE"})).removed}async function s(e){return t("/copy",{method:"POST",body:JSON.stringify(e)})}async function c(e){let r=new FormData;return r.append("file",e),t("/images",{method:"POST",body:r})}async function u(e,r){return(await t(`/annotations?source=${encodeURIComponent(e)}&ref_id=${encodeURIComponent(String(r))}`)).annotations}async function h(e){return(await t("/annotations",{method:"POST",body:JSON.stringify({...e,refId:String(e.refId)})})).annotation}async function p(e,r){await t(`/annotations/${encodeURIComponent(e)}`,{method:"PATCH",body:JSON.stringify(r)})}async function m(e){await t(`/annotations/${encodeURIComponent(e)}`,{method:"DELETE"})}e.s(["createAnnotation",0,h,"createFolder",0,n,"createNote",0,i,"deleteAnnotation",0,m,"deleteNode",0,d,"fetchAnnotations",0,u,"fetchNode",0,a,"fetchTree",0,r,"makeCopy",0,s,"saveItem",0,o,"updateAnnotation",0,p,"updateNode",0,l,"uploadImage",0,c])},71930,8780,e=>{"use strict";var t=e.i(75254);let r=(0,t.default)("bookmark",[["path",{d:"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z",key:"oz39mx"}]]);e.s(["Bookmark",0,r],71930);let a=(0,t.default)("file-pen-line",[["path",{d:"M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z",key:"ukzhwg"}],["path",{d:"M14.487 7.858A1 1 0 0 1 14 7V2",key:"1klhew"}],["path",{d:"M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516",key:"rxaxab"}],["path",{d:"M8 18h1",key:"13wk12"}]]);e.s(["FilePenLine",0,a],8780)},15361,e=>{"use strict";var t=e.i(43476),r=e.i(71645),a=e.i(3281),n=e.i(54858);let i={utd:e=>`/utd/topic/${e}/print`,amboss:e=>`/amboss/article/${e}/print`,uworld:e=>`/uworld-library/article/${e}/print`};function o(e,t,r){let a=`${(0,n.getBackendUrl)()}${i[e](t)}`,o=window.open("","_blank");return o?(o.name="medos-print-preview",o.opener=null,o.location.replace(a),!0):(window.MedOSMedia?.notify(`Allow pop-ups to open the complete print view for ${r}.`,"error"),!1)}e.s(["default",0,function({source:e,articleId:n,title:i,frameRef:l,className:d,compact:s=!1}){let c=(0,r.useCallback)(()=>o(e,n,i),[e,n,i]);return(0,r.useEffect)(()=>(function({openPrint:e,getFrameWindow:t,target:r=window}){let a=t=>{(t.ctrlKey||t.metaKey)&&"p"===t.key.toLowerCase()&&(t.preventDefault(),e())},n=r=>{if(r.data?.type!=="medos_print_article")return;let a=t();a&&r.source===a&&e()};return r.addEventListener("keydown",a),r.addEventListener("message",n),()=>{r.removeEventListener("keydown",a),r.removeEventListener("message",n)}})({openPrint:c,getFrameWindow:()=>l.current?.contentWindow??null}),[l,c]),(0,t.jsxs)("button",{type:"button",className:d,onClick:c,"aria-label":`Print / PDF: ${i}`,title:"Open complete article for native print or PDF",style:s?void 0:{display:"flex",alignItems:"center",gap:4,padding:"4px 9px",fontSize:11,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:5,cursor:"pointer",color:"var(--text-secondary)"},children:[(0,t.jsx)(a.Printer,{size:s?18:11,"aria-hidden":"true"}),(0,t.jsx)("span",{children:s?"Print":"Print / PDF"})]})},"openArticlePrint",0,o])},20757,e=>{"use strict";var t=e.i(43476),r=e.i(22016),a=e.i(71645),n=e.i(54858);let i={utd:"UpToDate",amboss:"AMBOSS",uworld:"UWorld Library",qbank:"UWorld Q-Bank",books:"Books",firstaid:"First Aid",drugs:"Drugs",diseases:"Diseases",calc:"Calculators",anatomy:"Anatomy"},o={utd:"#0ea5e9",amboss:"#8b5cf6",uworld:"#0d9488",qbank:"#db2777",books:"#d97706",firstaid:"#ea580c",drugs:"#64748b",diseases:"#dc2626",calc:"#3b4a60",anatomy:"#0891b2"},l=["utd","amboss","uworld","qbank","books","firstaid","drugs","diseases","calc","anatomy"];e.s(["default",0,function({source:e,id:d,collapsed:s=!1,embedded:c=!1}){let[u,h]=(0,a.useState)({}),[p,m]=(0,a.useState)(!0),[g,f]=(0,a.useState)(0),[b,x]=(0,a.useState)(s),[y,v]=(0,a.useState)(!0);return((0,a.useEffect)(()=>{let e=window.matchMedia("(min-width: 1000px)"),t=()=>v(e.matches);return t(),e.addEventListener("change",t),()=>e.removeEventListener("change",t)},[]),(0,a.useEffect)(()=>{if(!e||!d||!y&&!c)return;let t=!1;return m(!0),h({}),fetch(`${(0,n.getBackendUrl)()}/search/related?source=${encodeURIComponent(e)}&id=${encodeURIComponent(String(d))}`).then(e=>e.ok?e.json():Promise.reject(e.status)).then(e=>{t||(h(e.related||{}),f(e.total||0),m(!1))}).catch(()=>{t||m(!1)}),()=>{t=!0}},[e,d,y,c]),y||c)?(0,t.jsxs)("aside",{style:c?{width:"100%",maxHeight:"100%",overflowY:"auto",display:"flex",flexDirection:"column"}:{width:b?32:240,minWidth:b?32:240,maxHeight:"100%",overflowY:"auto",borderLeft:"1px solid var(--border)",background:"rgba(248,247,244,0.9)",display:"flex",flexDirection:"column",flexShrink:0,transition:"width .2s, min-width .2s"},children:[!c&&(0,t.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:b?"12px 6px":"10px 12px",borderBottom:"1px solid var(--border)",position:"sticky",top:0,background:"rgba(248,247,244,0.97)",zIndex:1},children:[!b&&(0,t.jsx)("span",{style:{fontFamily:"var(--font-mono)",fontSize:9,letterSpacing:"0.16em",textTransform:"uppercase",color:"var(--text-muted)",fontWeight:600},children:"Related reading"}),(0,t.jsx)("button",{type:"button",onClick:()=>x(e=>!e),title:b?"Expand related reading":"Collapse",style:{background:"none",border:"none",cursor:"pointer",padding:2,color:"var(--text-muted)",lineHeight:1,marginLeft:b?0:"auto"},children:b?(0,t.jsx)("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",children:(0,t.jsx)("path",{d:"m9 18 6-6-6-6"})}):(0,t.jsx)("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",children:(0,t.jsx)("path",{d:"m15 18-6-6 6-6"})})})]}),(!b||c)&&(0,t.jsx)("div",{style:{padding:"10px 12px",flex:1},children:p?(0,t.jsx)("div",{style:{fontSize:12,color:"var(--text-muted)",fontStyle:"italic"},children:"Loading…"}):g>0?Object.keys(u).sort((e,t)=>{let r=l.indexOf(e),a=l.indexOf(t);return(r<0?99:r)-(a<0?99:a)}).map(e=>{let a=u[e];return(0,t.jsxs)("section",{style:{marginBottom:16},children:[(0,t.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:5,marginBottom:5},children:[(0,t.jsx)("span",{style:{display:"inline-block",width:5,height:5,borderRadius:"50%",background:o[e]||"#94a3b8",flexShrink:0}}),(0,t.jsxs)("span",{style:{fontFamily:"var(--font-mono)",fontSize:9,letterSpacing:"0.14em",textTransform:"uppercase",color:"var(--text-muted)",fontWeight:600},children:[i[e]||e," (",a.length,")"]})]}),a.map(e=>(0,t.jsx)(r.default,{href:e.href,onClick:t=>{var r;return r=e.href,void((t.ctrlKey||t.metaKey||1===t.button)&&(t.preventDefault(),window.dispatchEvent(new CustomEvent("TabBar:open",{detail:{href:r}}))))},style:{display:"block",fontSize:12,color:"var(--text-secondary)",textDecoration:"none",padding:"3px 0",borderBottom:"1px dashed transparent",transition:"color .12s, border-color .12s",lineHeight:1.4},onMouseEnter:e=>{let t=e.currentTarget;t.style.color="var(--accent-strong)",t.style.borderBottomColor="var(--accent-dim)"},onMouseLeave:e=>{let t=e.currentTarget;t.style.color="var(--text-secondary)",t.style.borderBottomColor="transparent"},children:e.title},`${e.source}:${e.id}`))]},e)}):(0,t.jsx)("div",{style:{fontSize:11,color:"var(--text-muted)",fontStyle:"italic",lineHeight:1.5},children:"No linked concepts for this article yet."})})]}):null}])},86062,e=>{"use strict";var t=e.i(43476),r=e.i(71645),a=e.i(94873),n=e.i(57194);function i(e,t=600){return"string"==typeof e?e.trim().slice(0,t):""}e.s(["default",0,function({frameRef:e}){let[o,l]=(0,r.useState)(null);return((0,r.useEffect)(()=>{let t=t=>{let r=function(e,t,{origin:r}={}){if(!t||e?.source!==t)return null;let a=e?.data,o=a?.type==="medos_media_open"?a.descriptor:null;if(!o||"image"!==o.kind&&"table"!==o.kind)return null;let l=(0,n.normalizeTraySourceUrl)(o.sourceUrl,{origin:r});if(o.sourceUrl&&!l)return null;let d=i(o.title)||("table"===o.kind?"Table":"Image"),s=i(o.source)||"MedOS",c=i(o.fileName,260)||void 0;if("image"===o.kind){let e=(0,n.normalizeTrayResourceUrl)(o.resourceUrl,{origin:r});return e?Object.freeze({kind:"image",title:d,source:s,sourceUrl:l,resourceUrl:e,...c?{fileName:c}:{}}):null}let u=(0,n.sanitizeTrayHtml)(o.html,{origin:r});return/<table(?:\s|>)/i.test(u)?Object.freeze({kind:"table",title:d,source:s,sourceUrl:l,html:u,plainText:i(o.plainText,25e4),...c?{fileName:c}:{}}):null}(t,e.current?.contentWindow??null,{origin:window.location.origin});r&&l(r)};return window.addEventListener("message",t),()=>window.removeEventListener("message",t)},[e]),o)?(0,t.jsx)(a.default,{open:!0,onClose:()=>l(null),title:o.title,source:o.source,sourceUrl:o.sourceUrl,fileName:o.fileName,imageUrl:"image"===o.kind?o.resourceUrl:void 0,html:"table"===o.kind?o.html:void 0,mediaDescriptor:o}):null}],86062)},24455,90857,58752,17700,e=>{"use strict";var t=e.i(43476),r=e.i(71645),a=e.i(47919),n=e.i(31278),i=e.i(27612),o=e.i(37727),l=e.i(86527);let d=[{key:"yellow",swatch:"#fde68a",label:"Yellow"},{key:"green",swatch:"#bbf7d0",label:"Green"},{key:"blue",swatch:"#bfdbfe",label:"Blue"},{key:"pink",swatch:"#fbcfe8",label:"Pink"},{key:"purple",swatch:"#ddd6fe",label:"Purple"}];function s(e){let t=Number(e);return Number.isFinite(t)?Math.trunc(t):-1}e.s(["default",0,function({source:e,refId:c,iframeRef:u,enabled:h=!0}){let[p,m]=(0,r.useState)([]),[g,f]=(0,r.useState)(null),[b,x]=(0,r.useState)("yellow"),[y,v]=(0,r.useState)(""),[k,w]=(0,r.useState)(!1),[j,S]=(0,r.useState)(""),E=(0,r.useRef)([]);E.current=p;let C=(0,r.useCallback)(()=>{let t=u.current?.contentWindow;t&&null!=c&&t.postMessage({type:"medos_apply_annotations",source:e,refId:String(c),items:E.current},"*")},[u,c,e]),z=(0,r.useCallback)(async()=>{if(null==c)return void m([]);try{let t=await (0,l.fetchAnnotations)(e,c);m(t),S("")}catch(e){S(e instanceof Error?e.message:"Could not load highlights")}},[c,e]);(0,r.useEffect)(()=>{f(null),z()},[z]),(0,r.useEffect)(()=>{C()},[p,C]),(0,r.useEffect)(()=>{if(!h||null==c)return;let e=[90,350,900,1800].map(e=>window.setTimeout(C,e));return()=>e.forEach(e=>window.clearTimeout(e))},[p,h,C,c]),(0,r.useEffect)(()=>{if(h&&null!=c)return window.addEventListener("message",t),()=>window.removeEventListener("message",t);function t(t){let r=t.data;if(r&&"object"==typeof r&&r.source===e&&(null==r.refId||String(r.refId)===String(c))){if("medos_annotation_ready"===r.type)return void C();if("medos_annotation_selection"===r.type&&r.rect){f({mode:"new",selection:{start:s(r.start),end:s(r.end),quote:String(r.quote||""),prefix:String(r.prefix||""),suffix:String(r.suffix||""),rect:r.rect}}),x("yellow"),v(""),S("");return}if("medos_annotation_click"===r.type&&r.rect){let e=E.current.find(e=>e.id===String(r.id||""));if(!e)return;f({mode:"edit",annotation:e,rect:r.rect}),x(e.color||"yellow"),v(e.note||""),S("")}}}},[h,C,c,e]);let L=u.current?.getBoundingClientRect(),T=g?"new"===g.mode?g.selection.rect:g.rect:null,M=L&&T?Math.min(Math.max(8,L.left+T.left+T.width/2-160),Math.max(8,window.innerWidth-328)):0,R=g?.mode==="edit"?300:260,U=L&&T?L.top+T.top+T.height+10:0,I=L&&T?L.top+T.top-R-10:0,$=g?Math.max(8,U+R>window.innerHeight?I:U):0;async function D(){if(g&&"new"===g.mode&&null!=c){w(!0),S("");try{await (0,l.createAnnotation)({source:e,refId:c,quote:g.selection.quote,prefix:g.selection.prefix,suffix:g.selection.suffix,start:g.selection.start,end:g.selection.end,color:b,note:y.trim()}),await z(),f(null),u.current?.contentWindow?.postMessage({type:"medos_clear_selection"},"*")}catch(e){S(e instanceof Error?e.message:"Could not save the highlight")}finally{w(!1)}}}async function N(){if(g&&"edit"===g.mode){w(!0),S("");try{await (0,l.updateAnnotation)(g.annotation.id,{color:b,note:y.trim()}),await z(),f(null)}catch(e){S(e instanceof Error?e.message:"Could not update the highlight")}finally{w(!1)}}}async function O(){if(g&&"edit"===g.mode){w(!0),S("");try{await (0,l.deleteAnnotation)(g.annotation.id),await z(),f(null)}catch(e){S(e instanceof Error?e.message:"Could not delete the highlight")}finally{w(!1)}}}if(!h||null==c||!g)return null;let P="new"===g.mode?g.selection.quote:g.annotation.quote;return(0,t.jsxs)("div",{"data-medos-annotation-popover":!0,style:{position:"fixed",top:$,left:M,width:320,zIndex:4e3,background:"var(--bg-card)",color:"var(--text-primary)",border:"1px solid var(--border-strong, var(--border))",borderRadius:12,boxShadow:"0 18px 44px rgba(15,23,42,0.28)",padding:12},onMouseDown:e=>e.stopPropagation(),children:[(0,t.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:6,marginBottom:8},children:[(0,t.jsx)(a.Highlighter,{size:14,color:"#d97706"}),(0,t.jsx)("strong",{style:{fontSize:11.5,letterSpacing:"0.04em",textTransform:"uppercase"},children:"new"===g.mode?"Highlight":"Edit highlight"}),(0,t.jsx)("button",{type:"button",onClick:()=>f(null),title:"Close",style:{marginLeft:"auto",background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",display:"flex",padding:2},children:(0,t.jsx)(o.X,{size:14})})]}),(0,t.jsx)("div",{style:{fontSize:12,lineHeight:1.45,color:"var(--text-secondary)",background:"var(--bg-subtle, rgba(148,163,184,0.12))",borderRadius:7,padding:"7px 9px",marginBottom:9,maxHeight:74,overflow:"auto"},children:P.length>320?`${P.slice(0,320)}…`:P}),(0,t.jsx)("div",{style:{display:"flex",alignItems:"center",gap:7,marginBottom:9},children:d.map(e=>(0,t.jsx)("button",{type:"button",title:e.label,"aria-label":`${e.label} highlight`,onClick:()=>x(e.key),style:{width:24,height:24,borderRadius:999,cursor:"pointer",background:e.swatch,border:b===e.key?"2px solid var(--text-primary)":"1px solid rgba(15,23,42,0.18)",boxShadow:b===e.key?"0 0 0 2px var(--bg-card)":"none"}},e.key))}),(0,t.jsx)("textarea",{value:y,onChange:e=>v(e.target.value),placeholder:"Add a note (optional)",rows:3,style:{width:"100%",resize:"vertical",fontSize:12.5,lineHeight:1.45,padding:"7px 9px",borderRadius:7,border:"1px solid var(--border)",background:"var(--bg-base)",color:"var(--text-primary)",outline:"none",minHeight:58,maxHeight:160}}),j&&(0,t.jsx)("div",{style:{marginTop:7,fontSize:11.5,color:"var(--red, #ef4444)",fontWeight:600},children:j}),(0,t.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:7,marginTop:10},children:["edit"===g.mode&&(0,t.jsxs)("button",{type:"button",onClick:O,disabled:k,title:"Delete highlight",style:{display:"inline-flex",alignItems:"center",gap:4,cursor:"pointer",padding:"5px 9px",borderRadius:7,fontSize:11.5,fontWeight:700,border:"1px solid rgba(239,68,68,0.35)",background:"rgba(239,68,68,0.1)",color:"#dc2626"},children:[(0,t.jsx)(i.Trash2,{size:13})," Delete"]}),(0,t.jsx)("button",{type:"button",onClick:()=>f(null),disabled:k,style:{marginLeft:"auto",padding:"5px 11px",borderRadius:7,cursor:"pointer",fontSize:11.5,fontWeight:700,border:"1px solid var(--border)",background:"transparent",color:"var(--text-secondary)"},children:"Cancel"}),(0,t.jsxs)("button",{type:"button",onClick:"new"===g.mode?D:N,disabled:k,style:{display:"inline-flex",alignItems:"center",gap:5,cursor:k?"default":"pointer",padding:"5px 12px",borderRadius:7,fontSize:11.5,fontWeight:800,border:"1px solid rgba(217,119,6,0.4)",background:"#d97706",color:"#fff",opacity:k?.7:1},children:[k&&(0,t.jsx)(n.Loader2,{size:13,className:"medos-spin"}),"new"===g.mode?"Highlight":"Save"]})]})]})}],24455);var c=e.i(71930);let u=(0,e.i(75254).default)("bookmark-check",[["path",{d:"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z",key:"oz39mx"}],["path",{d:"m9 10 2 2 4-4",key:"1gnqz4"}]]);e.s(["default",0,function({source:e,refId:a,title:i,href:o,className:d,showLabel:s=!1}){let[h,p]=(0,r.useState)(!1),[m,g]=(0,r.useState)(!1);async function f(){if(!m){g(!0);try{await (0,l.saveItem)({source:e,refId:String(a),title:i,href:o}),p(!0)}catch(e){window.alert(e instanceof Error?e.message:"Could not save this article.")}finally{g(!1)}}}(0,r.useEffect)(()=>{p(!1)},[e,a]);let b=h?u:c.Bookmark;return(0,t.jsxs)("button",{type:"button",onClick:f,className:d,style:d?void 0:{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,padding:"3px 8px",minWidth:30,height:28,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:6,cursor:"pointer",color:"var(--text-secondary)",fontSize:10.5,fontWeight:700,flexShrink:0},title:h?"Saved to Custom Library":"Save to Custom Library","aria-label":h?"Saved to Custom Library":"Save to Custom Library","aria-pressed":h,disabled:m,children:[m?(0,t.jsx)(n.Loader2,{size:s?14:17,className:"medos-spin"}):(0,t.jsx)(b,{size:s?14:17,color:h?"#16a34a":void 0}),s&&(0,t.jsx)("span",{children:h?"Saved":"Save"})]})}],90857);var h=e.i(8780);function p(e,t){return[{id:`${e}-reading`,label:"Reading",mode:"read",glyph:"menu_book",description:"Return focus to the article",run:t.returnToReading},{id:`${e}-save`,label:"Save article",mode:"collect",glyph:"bookmark_add",description:"Add this article to the media tray",run:()=>{var r,a;let n,i;t.addToTray((r=t.articleId,a=t.title,n=(a.trim().replace(/\s+/g," ")||`Article ${r}`).slice(0,160),{kind:"excerpt",title:n,source:(i=({utd:{label:"UpToDate",sourceUrl:`/uptodate?t=${r}`},amboss:{label:"AMBOSS",sourceUrl:`/amboss?doc=${r}`},uworld:{label:"UWorld Library",sourceUrl:`/library/uworld?doc=${r}`}})[e]).label,sourceUrl:i.sourceUrl,plainText:n}))}},{id:`${e}-print`,label:"Print / PDF",mode:"read",glyph:"print",description:"Open the complete print view",run:t.openPrint}]}e.s(["default",0,function({source:e,refId:a,title:i,className:o,showLabel:d=!1}){let[s,c]=(0,r.useState)(!1);async function u(){if(!s){c(!0);try{var t,r;t=(await (0,l.makeCopy)({source:e,refId:String(a),title:i})).node.id,r=`${i} \xb7 editable copy`,window.dispatchEvent(new CustomEvent("TabBar:open",{detail:{href:`/library/custom?doc=${encodeURIComponent(t)}`,title:r}}))}catch(e){window.alert(e instanceof Error?e.message:"Could not create an editable copy.")}finally{c(!1)}}}return(0,t.jsxs)("button",{type:"button",onClick:u,className:o,style:o?void 0:{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,padding:"3px 8px",minWidth:30,height:28,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:6,cursor:"pointer",color:"var(--text-secondary)",fontSize:10.5,fontWeight:700,flexShrink:0},title:"Edit a copy of this article","aria-label":"Edit a copy of this article",disabled:s,children:[s?(0,t.jsx)(n.Loader2,{size:d?14:17,className:"medos-spin"}):(0,t.jsx)(h.FilePenLine,{size:d?14:17}),d&&(0,t.jsx)("span",{children:"Edit copy"})]})}],58752),e.s(["buildLibraryReaderHaloCommands",0,function(e){let t=e.source;return[{id:`${t}-contents`,label:"Contents",mode:"read",glyph:"toc",description:"Open the article library",run:()=>e.openPanel("contents")},{id:`${t}-find`,label:"Find",mode:"read",glyph:"find_in_page",description:"Focus the existing article search",run:()=>{e.openPanel("contents"),e.focusSearch()}},...e.hasImages?[{id:`${t}-images`,label:"Images",mode:"read",glyph:"image",description:"Open article images",run:()=>e.openPanel("images")}]:[],{id:`${t}-related`,label:"Related",mode:"read",glyph:"link",description:"Open related library content",run:()=>e.openPanel("related")},...p(t,e)]},"buildUtdReaderHaloCommands",0,function(e){return[{id:"utd-contents",label:"Contents",mode:"read",glyph:"toc",description:"Open topic contents",run:()=>e.openContents(e.hasOutline?"outline":"topics")},{id:"utd-find",label:"Find",mode:"read",glyph:"find_in_page",description:"Find within this topic",run:e.openFind},...e.hasImages?[{id:"utd-images",label:"Images",mode:"read",glyph:"image",description:"Open related figures and tables",run:e.openImages}]:[],...e.hasRelated?[{id:"utd-related",label:"Related",mode:"read",glyph:"link",description:"Open related topics and graphics",run:e.openRelated}]:[],...p("utd",e)]},"createDeferredFocusController",0,function(e,t){let r=null;return{schedule(a){null!==r&&t(r),r=e(()=>{r=null,a()})},cancel(){null!==r&&(t(r),r=null)}}},"registerArticleReaderHaloCommands",0,function(e,t){let r=e.map(e=>t(e));return()=>r.forEach(e=>e())}],17700)},73375,e=>{"use strict";let t=(0,e.i(75254).default)("chevron-left",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);e.s(["ChevronLeft",0,t],73375)},78583,70956,e=>{"use strict";var t=e.i(75254);let r=(0,t.default)("file-text",[["path",{d:"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",key:"1oefj6"}],["path",{d:"M14 2v5a1 1 0 0 0 1 1h5",key:"wfsgrz"}],["path",{d:"M10 9H8",key:"b1mrlr"}],["path",{d:"M16 13H8",key:"t4e002"}],["path",{d:"M16 17H8",key:"z1uh3a"}]]);e.s(["FileText",0,r],78583);let a=(0,t.default)("list",[["path",{d:"M3 5h.01",key:"18ugdj"}],["path",{d:"M3 12h.01",key:"nlz23k"}],["path",{d:"M3 19h.01",key:"noohij"}],["path",{d:"M8 5h13",key:"1pao27"}],["path",{d:"M8 12h13",key:"1za7za"}],["path",{d:"M8 19h13",key:"m83p4d"}]]);e.s(["List",0,a],70956)},58524,e=>{"use strict";let t=(0,e.i(75254).default)("link-2",[["path",{d:"M9 17H7A5 5 0 0 1 7 7h2",key:"8i5ue5"}],["path",{d:"M15 7h2a5 5 0 1 1 0 10h-2",key:"1b9ql8"}],["line",{x1:"8",x2:"16",y1:"12",y2:"12",key:"1jonct"}]]);e.s(["Link2",0,t],58524)},52008,e=>{"use strict";let t=(0,e.i(75254).default)("layers",[["path",{d:"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",key:"zw3jo"}],["path",{d:"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",key:"1wduqc"}],["path",{d:"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",key:"kqbvx6"}]]);e.s(["Layers",0,t],52008)},24247,e=>{"use strict";let t=(0,e.i(75254).default)("image-off",[["line",{x1:"2",x2:"22",y1:"2",y2:"22",key:"a6p6uj"}],["path",{d:"M10.41 10.41a2 2 0 1 1-2.83-2.83",key:"1bzlo9"}],["line",{x1:"13.5",x2:"6",y1:"13.5",y2:"21",key:"1q0aeu"}],["line",{x1:"18",x2:"21",y1:"12",y2:"15",key:"5mozeu"}],["path",{d:"M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59",key:"mmje98"}],["path",{d:"M21 15V5a2 2 0 0 0-2-2H9",key:"43el77"}]]);e.s(["ImageOff",0,t],24247)},66545,e=>{"use strict";var t=e.i(43476),r=e.i(71645),a=e.i(24247),n=e.i(31278),i=e.i(98361),o=e.i(67240),l=e.i(37727),d=e.i(54212),s=e.i(20354),c=e.i(54858),u=e.i(49311),h=e.i(84651);function p(e){return Math.min(3,Math.max(.65,Number(e.toFixed(2))))}async function m({imageUrl:e,thumbUrl:t,fetchImpl:r=fetch,allowThumbnail:a=!0}){let n=await r(e).catch(()=>null);if(n?.ok)return{response:n,resourceUrl:e};if(!a)return null;let i=await r(t).catch(()=>null);return i?.ok?{response:i,resourceUrl:t}:null}e.s(["default",0,function({graphicId:e,onClose:g}){let[f,b]=(0,r.useState)(null),[x,y]=(0,r.useState)(null),[v,k]=(0,r.useState)(null),[w,j]=(0,r.useState)("loading"),[S,E]=(0,r.useState)(null),[C,z]=(0,r.useState)(1),L=(0,r.useRef)(null),T=(0,c.getBackendUrl)(),M=`${T}/utd/graphic/${e}`,R=`${T}/utd/graphic/${e}/meta`,U=`${T}/utd/thumb/${e}`;(0,r.useEffect)(()=>{let e=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=e}},[]),(0,r.useEffect)(()=>{function e(e){let t=e.target,r=t?.tagName==="INPUT"||t?.tagName==="TEXTAREA";"Escape"===e.key?g():r||("+"===e.key||"="===e.key?(e.preventDefault(),z(e=>p(e+.15))):"-"===e.key||"_"===e.key?(e.preventDefault(),z(e=>p(e-.15))):"0"===e.key&&(e.preventDefault(),P()))}return document.addEventListener("keydown",e),()=>document.removeEventListener("keydown",e)},[g]),(0,r.useEffect)(()=>{b(null),y(null),k(null),j("loading"),E(null),z(1),L.current?.scrollTo({top:0,left:0});let e=!1,t=null;return async function(){let r=null;try{let t=await fetch(R);t.ok&&(r=await t.json(),!e&&r&&k(r))}catch{}let a=await m({imageUrl:M,thumbUrl:U,allowThumbnail:!r?.imageHtml});if(!e){if(a){let r=await a.response.blob();if(e)return;b(t=URL.createObjectURL(r)),y(a.resourceUrl),j("ok");return}if(r?.imageHtml)return j("ok");j("error")}}(),()=>{e=!0,t&&URL.revokeObjectURL(t)}},[e,M,R,U]);let I=v?.title||v?.caption||`Figure / Table #${e}`,$=v?.caption||v?.legendText,D="ok"===w&&!f&&!!v?.imageHtml,N=(0,r.useMemo)(()=>(function({base:e,graphicId:t,label:r,htmlTable:a,resourceUrl:n}){let i=`${e}/utd/graphic/${t}`;return a?Object.freeze({kind:"table",title:r,source:"UpToDate",sourceUrl:`${i}/html`,element:a}):Object.freeze({kind:"image",title:r,source:"UpToDate",sourceUrl:i,resourceUrl:n&&!n.startsWith("blob:")?n:i})})({base:T,graphicId:e,label:I,htmlTable:D?S:null,resourceUrl:x}),[T,e,D,S,x,I]);function O(e){z(t=>p(t+e))}function P(){z(1),requestAnimationFrame(()=>{L.current?.scrollTo({top:0,left:0,behavior:"smooth"})})}let A=(0,r.useCallback)(e=>{z(p(e))},[]),H=(0,r.useCallback)(()=>{z(e=>e<1.8?p(1.8):1)},[]),_=(0,r.useCallback)(e=>{let t=e?.querySelector("table")||null;E(e=>e===t?e:t)},[]);(0,u.usePinchZoom)(L,{value:C,min:.65,max:3,onChange:A,ignoreSelector:".utd-graphic-controls"}),(0,u.useDoubleTap)(L,H,{ignoreSelector:".utd-graphic-controls"});let B={"--utd-graphic-zoom":C,zoom:C};return(0,t.jsxs)(t.Fragment,{children:[(0,t.jsx)("div",{className:"utd-graphic-backdrop",onClick:g}),(0,t.jsxs)("section",{className:"utd-graphic-drawer",role:"dialog","aria-modal":"true","aria-label":I,onClick:e=>e.stopPropagation(),children:[(0,t.jsxs)("header",{className:"utd-graphic-header",children:[(0,t.jsxs)("div",{className:"utd-graphic-title-block",children:[(0,t.jsx)("span",{className:"utd-graphic-kicker",children:"UpToDate visual"}),(0,t.jsx)("h2",{children:I})]}),(0,t.jsxs)("div",{className:"utd-graphic-controls","aria-label":"Graphic controls",children:["ok"===w&&(!D||S)&&(0,t.jsx)(h.default,{descriptor:N,compact:!0}),(0,t.jsx)("button",{type:"button",onClick:()=>O(-.15),disabled:C<=.65,title:"Zoom out","aria-label":"Zoom out",children:(0,t.jsx)(s.ZoomOut,{size:16})}),(0,t.jsx)("input",{type:"range",min:.65,max:3,step:.05,value:C,onChange:e=>z(p(Number(e.target.value))),"aria-label":"Zoom"}),(0,t.jsx)("button",{type:"button",onClick:()=>O(.15),disabled:C>=3,title:"Zoom in","aria-label":"Zoom in",children:(0,t.jsx)(d.ZoomIn,{size:16})}),(0,t.jsx)("span",{className:"utd-graphic-zoom-readout",children:`${Math.round(100*C)}%`}),(0,t.jsx)("button",{type:"button",onClick:function(){z(.65),requestAnimationFrame(()=>{L.current?.scrollTo({top:0,left:0,behavior:"smooth"})})},title:"Overview zoom","aria-label":"Overview zoom",children:(0,t.jsx)(i.Maximize2,{size:16})}),(0,t.jsx)("button",{type:"button",onClick:P,title:"Reset view","aria-label":"Reset view",children:(0,t.jsx)(o.RotateCcw,{size:16})}),(0,t.jsx)("button",{type:"button",className:"utd-graphic-close",onClick:g,title:"Close","aria-label":"Close",children:(0,t.jsx)(l.X,{size:18})})]})]}),(0,t.jsxs)("div",{className:"utd-graphic-stage",ref:L,onWheel:function(e){(e.ctrlKey||e.metaKey)&&(e.preventDefault(),O(e.deltaY<0?.15:-.15))},children:["loading"===w&&(0,t.jsxs)("div",{className:"utd-graphic-state",children:[(0,t.jsx)(n.Loader2,{size:30,style:{animation:"utdGraphicSpin 1s linear infinite"}}),(0,t.jsx)("span",{children:"Decrypting graphic..."})]}),"error"===w&&(0,t.jsxs)("div",{className:"utd-graphic-state",children:[(0,t.jsx)("div",{className:"utd-graphic-state-icon",children:(0,t.jsx)(a.ImageOff,{size:30})}),(0,t.jsxs)("p",{children:["Graphic could not be loaded.",(0,t.jsx)("small",{children:"Try reopening it or restart MedOS if the local library is still starting."})]})]}),"ok"===w&&f&&(0,t.jsx)("div",{className:"utd-graphic-zoom-content",style:B,"data-medos-media-pan-active":C>1?"true":void 0,children:(0,t.jsxs)("figure",{className:"utd-graphic-figure",children:[(0,t.jsx)("img",{src:f,alt:I,className:"utd-graphic-image",draggable:C<=1,"data-medos-media-title":I,"data-medos-media-source":"UpToDate","data-medos-media-source-url":M}),$&&(0,t.jsx)("figcaption",{children:$})]})}),D&&(0,t.jsx)("div",{className:"utd-graphic-zoom-content is-html",style:B,"data-medos-media-pan-active":C>1?"true":void 0,children:(0,t.jsx)("div",{ref:_,className:"utd-graphic-html",dangerouslySetInnerHTML:{__html:v?.imageHtml||""}})})]})]}),(0,t.jsx)("style",{children:`
        @keyframes utdGraphicSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .utd-graphic-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000 !important;
          background: rgba(6, 12, 24, 0.68);
          backdrop-filter: blur(2px);
        }

        .utd-graphic-drawer {
          position: fixed;
          inset: 18px;
          z-index: 1001 !important;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          width: auto;
          background: #f7f9fc;
          border: 1px solid rgba(216, 226, 240, 0.92);
          border-radius: 10px;
          box-shadow: 0 24px 80px rgba(2, 6, 23, 0.32);
        }

        .utd-graphic-header {
          min-height: 58px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 10px 12px 10px 16px;
          border-bottom: 1px solid rgba(216, 226, 240, 0.96);
          background: rgba(255, 255, 255, 0.96);
        }

        .utd-graphic-title-block {
          min-width: 0;
          display: grid;
          gap: 2px;
        }

        .utd-graphic-title-block h2 {
          margin: 0;
          overflow: hidden;
          color: var(--text-primary);
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .utd-graphic-kicker {
          color: #00857c;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        .utd-graphic-controls {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .utd-graphic-controls button {
          width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(148, 163, 184, 0.45);
          border-radius: 7px;
          background: #fff;
          color: #334155;
          cursor: pointer;
        }

        .utd-graphic-controls button:hover:not(:disabled) {
          border-color: rgba(0, 133, 124, 0.45);
          color: #00756e;
          background: rgba(0, 133, 124, 0.06);
        }

        .utd-graphic-controls button:disabled {
          cursor: default;
          color: #cbd5e1;
          background: #f8fafc;
        }

        .utd-graphic-controls input[type="range"] {
          width: 124px;
          accent-color: #00857c;
        }

        .utd-graphic-close {
          margin-left: 4px;
        }

        .utd-graphic-zoom-readout {
          min-width: 44px;
          color: #475569;
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }

        .utd-graphic-stage {
          flex: 1;
          min-height: 0;
          overflow: auto;
          overscroll-behavior: contain;
          touch-action: pan-x pan-y;
          -webkit-overflow-scrolling: touch;
          padding: 18px;
          background:
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            #eef3f8;
          background-size: 22px 22px;
        }

        .utd-graphic-zoom-content {
          width: fit-content;
          min-width: min(100%, 980px);
          max-width: none;
          margin: 0 auto;
          transform-origin: top center;
        }

        .utd-graphic-zoom-content.is-html {
          min-width: min(100%, 1120px);
        }

        .utd-graphic-figure {
          width: fit-content;
          min-width: min(100%, 760px);
          max-width: 100%;
          margin: 0 auto;
          padding: 14px;
          border: 1px solid rgba(203, 213, 225, 0.9);
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
        }

        .utd-graphic-image {
          display: block;
          max-width: min(100%, 1600px);
          max-height: none;
          object-fit: contain;
          user-select: none;
        }

        .utd-graphic-figure figcaption {
          max-width: 980px;
          margin: 12px 0 0;
          padding-top: 10px;
          border-top: 1px solid rgba(226, 232, 240, 0.94);
          color: #475569;
          font-size: 12px;
          line-height: 1.6;
        }

        .utd-graphic-html {
          min-width: min(1120px, calc(100vw - 84px));
          padding: 16px;
          border: 1px solid rgba(203, 213, 225, 0.9);
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
          color: #0f172a;
          font-size: 13px;
          line-height: 1.5;
        }

        .utd-graphic-html img {
          max-width: 100%;
          height: auto;
        }

        .utd-graphic-html table,
        .utd-graphic-html .table-default-style,
        .utd-graphic-html .table-header-footer-style,
        .utd-graphic-html .table-footer-only-style {
          width: 100%;
          min-width: 880px;
          border-collapse: collapse;
          color: #0f172a;
          font-size: 12px;
          line-height: 1.45;
        }

        .utd-graphic-html th,
        .utd-graphic-html td {
          border: 1px solid #d8e2f0;
          padding: 8px 10px;
          vertical-align: top;
        }

        .utd-graphic-html th {
          background: #f8fafc;
          color: #1e293b;
          font-weight: 700;
        }

        .utd-graphic-html .ttl {
          margin: 0 0 14px;
          color: #0f172a;
          font-size: 15px;
          font-weight: 700;
          line-height: 1.35;
        }

        .utd-graphic-html .graphic_footnotes {
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid #d8e2f0;
          color: #475569;
          font-size: 11px;
          line-height: 1.6;
        }

        html[data-theme="dark"] .utd-graphic-drawer {
          background: var(--bg-card);
          border-color: var(--border);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.54);
        }

        html[data-theme="dark"] .utd-graphic-header {
          background: rgba(15, 23, 42, 0.96);
          border-bottom-color: var(--border);
        }

        html[data-theme="dark"] .utd-graphic-controls button {
          background: var(--bg-subtle);
          border-color: var(--border);
          color: var(--text-primary);
        }

        html[data-theme="dark"] .utd-graphic-controls button:hover:not(:disabled) {
          background: rgba(45, 212, 191, 0.12);
          border-color: rgba(45, 212, 191, 0.4);
          color: #67e8f9;
        }

        html[data-theme="dark"] .utd-graphic-controls button:disabled {
          background: rgba(15, 23, 42, 0.72);
          color: var(--text-muted);
        }

        html[data-theme="dark"] .utd-graphic-zoom-readout,
        html[data-theme="dark"] .utd-graphic-state,
        html[data-theme="dark"] .utd-graphic-state p,
        html[data-theme="dark"] .utd-graphic-state small {
          color: var(--text-secondary);
        }

        html[data-theme="dark"] .utd-graphic-stage {
          background:
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            var(--bg-base);
          background-size: 22px 22px;
        }

        html[data-theme="dark"] .utd-graphic-figure,
        html[data-theme="dark"] .utd-graphic-html {
          background: var(--bg-card) !important;
          border-color: var(--border) !important;
          color: var(--text-primary) !important;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.32);
        }

        html[data-theme="dark"] .utd-graphic-figure figcaption {
          border-top-color: var(--border);
          color: var(--text-secondary);
        }

        html[data-theme="dark"] .utd-graphic-html table,
        html[data-theme="dark"] .utd-graphic-html thead,
        html[data-theme="dark"] .utd-graphic-html tbody,
        html[data-theme="dark"] .utd-graphic-html tfoot,
        html[data-theme="dark"] .utd-graphic-html tr,
        html[data-theme="dark"] .utd-graphic-html .table-default-style,
        html[data-theme="dark"] .utd-graphic-html .table-header-footer-style,
        html[data-theme="dark"] .utd-graphic-html .table-footer-only-style {
          background: var(--bg-card) !important;
          border-color: var(--border-strong) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th,
        html[data-theme="dark"] .utd-graphic-html td {
          background: var(--bg-card) !important;
          border-color: var(--border-strong) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th,
        html[data-theme="dark"] .utd-graphic-html thead td {
          background: var(--bg-subtle) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th *,
        html[data-theme="dark"] .utd-graphic-html td * {
          background: transparent !important;
          color: inherit !important;
          border-color: inherit !important;
        }

        html[data-theme="dark"] .utd-graphic-html tr:nth-child(even) td {
          background: rgba(30, 41, 59, 0.72) !important;
        }

        html[data-theme="dark"] .utd-graphic-html p,
        html[data-theme="dark"] .utd-graphic-html div,
        html[data-theme="dark"] .utd-graphic-html span,
        html[data-theme="dark"] .utd-graphic-html em,
        html[data-theme="dark"] .utd-graphic-html strong,
        html[data-theme="dark"] .utd-graphic-html li,
        html[data-theme="dark"] .utd-graphic-html .ttl {
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html a {
          color: #7dd3fc !important;
        }

        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes {
          border-top-color: var(--border);
          color: var(--text-secondary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes,
        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes * {
          color: var(--text-secondary) !important;
        }

        .utd-graphic-state {
          min-height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: #64748b;
          text-align: center;
        }

        .utd-graphic-state-icon {
          width: 68px;
          height: 68px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(0, 133, 124, 0.18);
          border-radius: 16px;
          background: rgba(0, 133, 124, 0.08);
          color: #00857c;
        }

        .utd-graphic-state p {
          margin: 0;
          color: #475569;
          font-size: 13px;
          line-height: 1.55;
        }

        .utd-graphic-state small {
          display: block;
          margin-top: 4px;
          color: #64748b;
          font-size: 11px;
        }

        @media (max-width: 720px) {
          .utd-graphic-drawer {
            inset: 0;
            border: 0;
            border-radius: 0;
          }

          .utd-graphic-header {
            min-height: 96px;
            align-items: stretch;
            flex-direction: column;
            gap: 9px;
            padding: calc(8px + env(safe-area-inset-top, 0px)) 10px 8px;
          }

          .utd-graphic-title-block h2 {
            font-size: 13px;
            white-space: normal;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
          }

          .utd-graphic-controls {
            width: 100%;
            gap: 5px;
          }

          .utd-graphic-controls input[type="range"] {
            flex: 1;
            min-width: 72px;
          }

          .utd-graphic-controls button {
            width: 34px;
            height: 34px;
          }

          .utd-graphic-stage {
            padding: 10px;
          }

          .utd-graphic-html {
            min-width: 760px;
            padding: 12px;
          }

          .utd-graphic-html table,
          .utd-graphic-html .table-default-style,
          .utd-graphic-html .table-header-footer-style,
          .utd-graphic-html .table-footer-only-style {
            min-width: 720px;
          }
        }
      `})]})}])}]);