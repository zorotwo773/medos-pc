(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,31278,e=>{"use strict";var t=e.i(17521);e.s(["Loader2",()=>t.default])},10980,e=>{"use strict";let t=(0,e.i(75254).default)("book-open",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);e.s(["BookOpen",0,t],10980)},49311,e=>{"use strict";var t=e.i(71645);function r(e,t,r){return Math.min(r,Math.max(t,e))}function a(e,t){return t?Math.round(e/t)*t:e}function i(e){let t=e.item(0),r=e.item(1);return t&&r?Math.hypot(t.clientX-r.clientX,t.clientY-r.clientY):0}function n(e){return{x:e.clientX,y:e.clientY}}function o(e){let t=0,r=0;for(let a=0;a<e.length;a+=1){let i=e.item(a);i&&(t+=i.clientX,r+=i.clientY)}let a=Math.max(1,e.length);return{x:t/a,y:r/a}}function l(e,t){return e instanceof HTMLElement&&(!!(t&&e.closest(t))||!!e.closest("a[href],button,input,select,textarea,summary,[contenteditable='true'],[role='button'],[role='link'],[role='menuitem'],[role='tab'],[data-touch-ignore],[data-no-swipe]"))}e.s(["isEditableTouchTarget",0,function(e){return e instanceof HTMLElement&&!!e.closest("input, textarea, select, [contenteditable='true']")},"useDoubleTap",0,function(e,r,a={}){let i=(0,t.useRef)(r),o=(0,t.useRef)(a);(0,t.useEffect)(()=>{i.current=r,o.current=a},[r,a]),(0,t.useEffect)(()=>{let t=e.current;if(!t||a.disabled)return;let r=!1,c=null,d=e=>{e.touches.length>1&&(r=!0)},u=e=>{let t=o.current;if(r){0===e.touches.length&&(r=!1);return}if(1!==e.changedTouches.length||e.touches.length>0||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector))return;let a=Date.now(),d=n(e.changedTouches[0]),u=t.maxDelayMs??280,s=t.maxDistancePx??28;if(c&&a-c.time<=u&&Math.hypot(d.x-c.x,d.y-c.y)<=s){e.preventDefault(),c=null,i.current();return}c={time:a,...d}},s=()=>{c=null,r=!1};return t.addEventListener("touchstart",d,{passive:!0}),t.addEventListener("touchend",u,{passive:!1}),t.addEventListener("touchcancel",s,{passive:!0}),()=>{t.removeEventListener("touchstart",d),t.removeEventListener("touchend",u),t.removeEventListener("touchcancel",s)}},[e,a.disabled,a.effectKey])},"useMultiTouchSwipe",0,function(e,r){let a=(0,t.useRef)(r);(0,t.useEffect)(()=>{a.current=r},[r]),(0,t.useEffect)(()=>{let t=e.current;if(!t||r.disabled)return;let i=null,n=null,c=!1,d=()=>{i=null,n=null,c=!1},u=e=>{let t=a.current;e.touches.length!==t.fingers||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)?d():(n=i=o(e.touches),c=!0)},s=e=>{let t=a.current;c&&e.touches.length===t.fingers&&(n=o(e.touches),e.preventDefault())},h=e=>{let t=a.current;if(!c||!i||!n||e.touches.length>=t.fingers)return;let r=n.x-i.x,o=n.y-i.y,l=Math.abs(r),u=Math.abs(o),s=t.minDistancePx??64,h=t.maxCrossAxisPx??72;(d(),l>=s&&u<=h)?r<0?t.onSwipeLeft?.():t.onSwipeRight?.():u>=s&&l<=h&&(o<0?t.onSwipeUp?.():t.onSwipeDown?.())};return t.addEventListener("touchstart",u,{passive:!0}),t.addEventListener("touchmove",s,{passive:!1}),t.addEventListener("touchend",h,{passive:!0}),t.addEventListener("touchcancel",d,{passive:!0}),()=>{t.removeEventListener("touchstart",u),t.removeEventListener("touchmove",s),t.removeEventListener("touchend",h),t.removeEventListener("touchcancel",d)}},[e,r.disabled,r.effectKey])},"usePinchZoom",0,function(e,n){let o=(0,t.useRef)(n.value),c=(0,t.useRef)(n.onChange),d=(0,t.useRef)(n);(0,t.useEffect)(()=>{o.current=n.value,c.current=n.onChange,d.current=n},[n]),(0,t.useEffect)(()=>{let t=e.current;if(!t||n.disabled)return;let u=!1,s=0,h=o.current,p=e=>{let t=d.current;2!==e.touches.length||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)||(s=i(e.touches),h=o.current,u=s>0)},m=e=>{if(!u||2!==e.touches.length||s<=0)return;let t=i(e.touches);if(t<=0)return;e.preventDefault();let n=d.current,o=r(a(t/s*h,n.step??.01),n.min,n.max);c.current(o)},g=e=>{e.touches.length<2&&(u=!1,s=0)};return t.addEventListener("touchstart",p,{passive:!0}),t.addEventListener("touchmove",m,{passive:!1}),t.addEventListener("touchend",g,{passive:!0}),t.addEventListener("touchcancel",g,{passive:!0}),()=>{t.removeEventListener("touchstart",p),t.removeEventListener("touchmove",m),t.removeEventListener("touchend",g),t.removeEventListener("touchcancel",g)}},[e,n.disabled,n.effectKey])},"useSwipeGesture",0,function(e,r){let a=(0,t.useRef)(r);(0,t.useEffect)(()=>{a.current=r},[r]),(0,t.useEffect)(()=>{let t=e.current;if(!t||r.disabled)return;let i=null,o=!1,c=e=>{let t=a.current;if(1!==e.touches.length||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector)){o=!1,i=null;return}o=!0,i=n(e.touches[0])},d=e=>{if(!o||!i||1!==e.changedTouches.length)return;let t=a.current,r=n(e.changedTouches[0]),l=r.x-i.x,c=r.y-i.y,d=Math.abs(l),u=Math.abs(c),s=t.minDistancePx??64,h=t.maxCrossAxisPx??72;(o=!1,i=null,d>=s&&u<=h)?l<0?t.onSwipeLeft?.():t.onSwipeRight?.():u>=s&&d<=h&&(c<0?t.onSwipeUp?.():t.onSwipeDown?.())},u=()=>{o=!1,i=null};return t.addEventListener("touchstart",c,{passive:!0}),t.addEventListener("touchend",d,{passive:!0}),t.addEventListener("touchcancel",u,{passive:!0}),()=>{t.removeEventListener("touchstart",c),t.removeEventListener("touchend",d),t.removeEventListener("touchcancel",u)}},[e,r.disabled,r.effectKey])},"useTrackpadPinch",0,function(e,i){let n=(0,t.useRef)(i.value),o=(0,t.useRef)(i.onChange),c=(0,t.useRef)(i);(0,t.useEffect)(()=>{n.current=i.value,o.current=i.onChange,c.current=i},[i]),(0,t.useEffect)(()=>{let t=e.current;if(!t||i.disabled)return;let d=e=>{let t=c.current;if(!e.ctrlKey&&!e.metaKey||!1!==t.ignoreInteractive&&l(e.target,t.ignoreSelector))return;if(e.preventDefault(),t.multiplicative){let a=t.step??.01,i=r(Math.exp(-e.deltaY*a),.8,1.25),l=r(n.current*i,t.min,t.max);o.current(l);return}let i=t.step??.04,d=e.deltaY<0?1:-1,u=r(a(n.current+d*i,i),t.min,t.max);o.current(u)};return t.addEventListener("wheel",d,{passive:!1}),()=>t.removeEventListener("wheel",d)},[e,i.disabled,i.effectKey])}])},55838,(e,t,r)=>{"use strict";var a=e.r(71645),i="function"==typeof Object.is?Object.is:function(e,t){return e===t&&(0!==e||1/e==1/t)||e!=e&&t!=t},n=a.useState,o=a.useEffect,l=a.useLayoutEffect,c=a.useDebugValue;function d(e){var t=e.getSnapshot;e=e.value;try{var r=t();return!i(e,r)}catch(e){return!0}}var u="u"<typeof window||void 0===window.document||void 0===window.document.createElement?function(e,t){return t()}:function(e,t){var r=t(),a=n({inst:{value:r,getSnapshot:t}}),i=a[0].inst,u=a[1];return l(function(){i.value=r,i.getSnapshot=t,d(i)&&u({inst:i})},[e,r,t]),o(function(){return d(i)&&u({inst:i}),e(function(){d(i)&&u({inst:i})})},[e]),c(r),r};r.useSyncExternalStore=void 0!==a.useSyncExternalStore?a.useSyncExternalStore:u},2239,(e,t,r)=>{"use strict";t.exports=e.r(55838)},52822,(e,t,r)=>{"use strict";var a=e.r(71645),i=e.r(2239),n="function"==typeof Object.is?Object.is:function(e,t){return e===t&&(0!==e||1/e==1/t)||e!=e&&t!=t},o=i.useSyncExternalStore,l=a.useRef,c=a.useEffect,d=a.useMemo,u=a.useDebugValue;r.useSyncExternalStoreWithSelector=function(e,t,r,a,i){var s=l(null);if(null===s.current){var h={hasValue:!1,value:null};s.current=h}else h=s.current;var p=o(e,(s=d(function(){function e(e){if(!c){if(c=!0,o=e,e=a(e),void 0!==i&&h.hasValue){var t=h.value;if(i(t,e))return l=t}return l=e}if(t=l,n(o,e))return t;var r=a(e);return void 0!==i&&i(t,r)?(o=e,t):(o=e,l=r)}var o,l,c=!1,d=void 0===r?null:r;return[function(){return e(t())},null===d?void 0:function(){return e(d())}]},[t,r,a,i]))[0],s[1]);return c(function(){h.hasValue=!0,h.value=p},[p]),u(p),p}},30224,(e,t,r)=>{"use strict";t.exports=e.r(52822)},50570,e=>{"use strict";let t=(0,e.i(75254).default)("grip-vertical",[["circle",{cx:"9",cy:"12",r:"1",key:"1vctgf"}],["circle",{cx:"9",cy:"5",r:"1",key:"hp0tcf"}],["circle",{cx:"9",cy:"19",r:"1",key:"fkjjf6"}],["circle",{cx:"15",cy:"12",r:"1",key:"1tmaij"}],["circle",{cx:"15",cy:"5",r:"1",key:"19l28e"}],["circle",{cx:"15",cy:"19",r:"1",key:"f4zoj3"}]]);e.s(["GripVertical",0,t],50570)},24247,e=>{"use strict";let t=(0,e.i(75254).default)("image-off",[["line",{x1:"2",x2:"22",y1:"2",y2:"22",key:"a6p6uj"}],["path",{d:"M10.41 10.41a2 2 0 1 1-2.83-2.83",key:"1bzlo9"}],["line",{x1:"13.5",x2:"6",y1:"13.5",y2:"21",key:"1q0aeu"}],["line",{x1:"18",x2:"21",y1:"12",y2:"15",key:"5mozeu"}],["path",{d:"M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59",key:"mmje98"}],["path",{d:"M21 15V5a2 2 0 0 0-2-2H9",key:"43el77"}]]);e.s(["ImageOff",0,t],24247)},66545,e=>{"use strict";var t=e.i(43476),r=e.i(71645),a=e.i(24247),i=e.i(31278),n=e.i(98361),o=e.i(67240),l=e.i(37727),c=e.i(54212),d=e.i(20354),u=e.i(54858),s=e.i(49311),h=e.i(84651);function p(e){return Math.min(3,Math.max(.65,Number(e.toFixed(2))))}async function m({imageUrl:e,thumbUrl:t,fetchImpl:r=fetch,allowThumbnail:a=!0}){let i=await r(e).catch(()=>null);if(i?.ok)return{response:i,resourceUrl:e};if(!a)return null;let n=await r(t).catch(()=>null);return n?.ok?{response:n,resourceUrl:t}:null}e.s(["default",0,function({graphicId:e,onClose:g}){let[f,x]=(0,r.useState)(null),[b,v]=(0,r.useState)(null),[y,k]=(0,r.useState)(null),[w,E]=(0,r.useState)("loading"),[j,L]=(0,r.useState)(null),[S,z]=(0,r.useState)(1),T=(0,r.useRef)(null),M=(0,u.getBackendUrl)(),D=`${M}/utd/graphic/${e}`,R=`${M}/utd/graphic/${e}/meta`,C=`${M}/utd/thumb/${e}`;(0,r.useEffect)(()=>{let e=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=e}},[]),(0,r.useEffect)(()=>{function e(e){let t=e.target,r=t?.tagName==="INPUT"||t?.tagName==="TEXTAREA";"Escape"===e.key?g():r||("+"===e.key||"="===e.key?(e.preventDefault(),z(e=>p(e+.15))):"-"===e.key||"_"===e.key?(e.preventDefault(),z(e=>p(e-.15))):"0"===e.key&&(e.preventDefault(),$()))}return document.addEventListener("keydown",e),()=>document.removeEventListener("keydown",e)},[g]),(0,r.useEffect)(()=>{x(null),v(null),k(null),E("loading"),L(null),z(1),T.current?.scrollTo({top:0,left:0});let e=!1,t=null;return async function(){let r=null;try{let t=await fetch(R);t.ok&&(r=await t.json(),!e&&r&&k(r))}catch{}let a=await m({imageUrl:D,thumbUrl:C,allowThumbnail:!r?.imageHtml});if(!e){if(a){let r=await a.response.blob();if(e)return;x(t=URL.createObjectURL(r)),v(a.resourceUrl),E("ok");return}if(r?.imageHtml)return E("ok");E("error")}}(),()=>{e=!0,t&&URL.revokeObjectURL(t)}},[e,D,R,C]);let N=y?.title||y?.caption||`Figure / Table #${e}`,U=y?.caption||y?.legendText,O="ok"===w&&!f&&!!y?.imageHtml,P=(0,r.useMemo)(()=>(function({base:e,graphicId:t,label:r,htmlTable:a,resourceUrl:i}){let n=`${e}/utd/graphic/${t}`;return a?Object.freeze({kind:"table",title:r,source:"UpToDate",sourceUrl:`${n}/html`,element:a}):Object.freeze({kind:"image",title:r,source:"UpToDate",sourceUrl:n,resourceUrl:i&&!i.startsWith("blob:")?i:n})})({base:M,graphicId:e,label:N,htmlTable:O?j:null,resourceUrl:b}),[M,e,O,j,b,N]);function K(e){z(t=>p(t+e))}function $(){z(1),requestAnimationFrame(()=>{T.current?.scrollTo({top:0,left:0,behavior:"smooth"})})}let I=(0,r.useCallback)(e=>{z(p(e))},[]),A=(0,r.useCallback)(()=>{z(e=>e<1.8?p(1.8):1)},[]),Z=(0,r.useCallback)(e=>{let t=e?.querySelector("table")||null;L(e=>e===t?e:t)},[]);(0,s.usePinchZoom)(T,{value:S,min:.65,max:3,onChange:I,ignoreSelector:".utd-graphic-controls"}),(0,s.useDoubleTap)(T,A,{ignoreSelector:".utd-graphic-controls"});let H={"--utd-graphic-zoom":S,zoom:S};return(0,t.jsxs)(t.Fragment,{children:[(0,t.jsx)("div",{className:"utd-graphic-backdrop",onClick:g}),(0,t.jsxs)("section",{className:"utd-graphic-drawer",role:"dialog","aria-modal":"true","aria-label":N,onClick:e=>e.stopPropagation(),children:[(0,t.jsxs)("header",{className:"utd-graphic-header",children:[(0,t.jsxs)("div",{className:"utd-graphic-title-block",children:[(0,t.jsx)("span",{className:"utd-graphic-kicker",children:"UpToDate visual"}),(0,t.jsx)("h2",{children:N})]}),(0,t.jsxs)("div",{className:"utd-graphic-controls","aria-label":"Graphic controls",children:["ok"===w&&(!O||j)&&(0,t.jsx)(h.default,{descriptor:P,compact:!0}),(0,t.jsx)("button",{type:"button",onClick:()=>K(-.15),disabled:S<=.65,title:"Zoom out","aria-label":"Zoom out",children:(0,t.jsx)(d.ZoomOut,{size:16})}),(0,t.jsx)("input",{type:"range",min:.65,max:3,step:.05,value:S,onChange:e=>z(p(Number(e.target.value))),"aria-label":"Zoom"}),(0,t.jsx)("button",{type:"button",onClick:()=>K(.15),disabled:S>=3,title:"Zoom in","aria-label":"Zoom in",children:(0,t.jsx)(c.ZoomIn,{size:16})}),(0,t.jsx)("span",{className:"utd-graphic-zoom-readout",children:`${Math.round(100*S)}%`}),(0,t.jsx)("button",{type:"button",onClick:function(){z(.65),requestAnimationFrame(()=>{T.current?.scrollTo({top:0,left:0,behavior:"smooth"})})},title:"Overview zoom","aria-label":"Overview zoom",children:(0,t.jsx)(n.Maximize2,{size:16})}),(0,t.jsx)("button",{type:"button",onClick:$,title:"Reset view","aria-label":"Reset view",children:(0,t.jsx)(o.RotateCcw,{size:16})}),(0,t.jsx)("button",{type:"button",className:"utd-graphic-close",onClick:g,title:"Close","aria-label":"Close",children:(0,t.jsx)(l.X,{size:18})})]})]}),(0,t.jsxs)("div",{className:"utd-graphic-stage",ref:T,onWheel:function(e){(e.ctrlKey||e.metaKey)&&(e.preventDefault(),K(e.deltaY<0?.15:-.15))},children:["loading"===w&&(0,t.jsxs)("div",{className:"utd-graphic-state",children:[(0,t.jsx)(i.Loader2,{size:30,style:{animation:"utdGraphicSpin 1s linear infinite"}}),(0,t.jsx)("span",{children:"Decrypting graphic..."})]}),"error"===w&&(0,t.jsxs)("div",{className:"utd-graphic-state",children:[(0,t.jsx)("div",{className:"utd-graphic-state-icon",children:(0,t.jsx)(a.ImageOff,{size:30})}),(0,t.jsxs)("p",{children:["Graphic could not be loaded.",(0,t.jsx)("small",{children:"Try reopening it or restart MedOS if the local library is still starting."})]})]}),"ok"===w&&f&&(0,t.jsx)("div",{className:"utd-graphic-zoom-content",style:H,"data-medos-media-pan-active":S>1?"true":void 0,children:(0,t.jsxs)("figure",{className:"utd-graphic-figure",children:[(0,t.jsx)("img",{src:f,alt:N,className:"utd-graphic-image",draggable:S<=1,"data-medos-media-title":N,"data-medos-media-source":"UpToDate","data-medos-media-source-url":D}),U&&(0,t.jsx)("figcaption",{children:U})]})}),O&&(0,t.jsx)("div",{className:"utd-graphic-zoom-content is-html",style:H,"data-medos-media-pan-active":S>1?"true":void 0,children:(0,t.jsx)("div",{ref:Z,className:"utd-graphic-html",dangerouslySetInnerHTML:{__html:y?.imageHtml||""}})})]})]}),(0,t.jsx)("style",{children:`
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