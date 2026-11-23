module.exports=[51292,a=>{"use strict";var b=a.i(87924),c=a.i(72131);let d=(0,a.i(60137).default)("image-off",[["line",{x1:"2",x2:"22",y1:"2",y2:"22",key:"a6p6uj"}],["path",{d:"M10.41 10.41a2 2 0 1 1-2.83-2.83",key:"1bzlo9"}],["line",{x1:"13.5",x2:"6",y1:"13.5",y2:"21",key:"1q0aeu"}],["line",{x1:"18",x2:"21",y1:"12",y2:"15",key:"5mozeu"}],["path",{d:"M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59",key:"mmje98"}],["path",{d:"M21 15V5a2 2 0 0 0-2-2H9",key:"43el77"}]]);var e=a.i(96221),f=a.i(34044),g=a.i(87654),h=a.i(33508),i=a.i(61690),j=a.i(69602),k=a.i(53250),l=a.i(8808),m=a.i(23696);function n(a){return Math.min(3,Math.max(.65,Number(a.toFixed(2))))}async function o({imageUrl:a,thumbUrl:b,fetchImpl:c=fetch,allowThumbnail:d=!0}){let e=await c(a).catch(()=>null);if(e?.ok)return{response:e,resourceUrl:a};if(!d)return null;let f=await c(b).catch(()=>null);return f?.ok?{response:f,resourceUrl:b}:null}a.s(["default",0,function({graphicId:a,onClose:p}){let[q,r]=(0,c.useState)(null),[s,t]=(0,c.useState)(null),[u,v]=(0,c.useState)(null),[w,x]=(0,c.useState)("loading"),[y,z]=(0,c.useState)(null),[A,B]=(0,c.useState)(1),C=(0,c.useRef)(null),D=(0,k.getBackendUrl)(),E=`${D}/utd/graphic/${a}`,F=`${D}/utd/graphic/${a}/meta`,G=`${D}/utd/thumb/${a}`;(0,c.useEffect)(()=>{let a=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=a}},[]),(0,c.useEffect)(()=>{function a(a){let b=a.target,c=b?.tagName==="INPUT"||b?.tagName==="TEXTAREA";"Escape"===a.key?p():c||("+"===a.key||"="===a.key?(a.preventDefault(),B(a=>n(a+.15))):"-"===a.key||"_"===a.key?(a.preventDefault(),B(a=>n(a-.15))):"0"===a.key&&(a.preventDefault(),M()))}return document.addEventListener("keydown",a),()=>document.removeEventListener("keydown",a)},[p]),(0,c.useEffect)(()=>{r(null),t(null),v(null),x("loading"),z(null),B(1),C.current?.scrollTo({top:0,left:0});let a=!1,b=null;return async function(){let c=null;try{let b=await fetch(F);b.ok&&(c=await b.json(),!a&&c&&v(c))}catch{}let d=await o({imageUrl:E,thumbUrl:G,allowThumbnail:!c?.imageHtml});if(!a){if(d){let c=await d.response.blob();if(a)return;r(b=URL.createObjectURL(c)),t(d.resourceUrl),x("ok");return}if(c?.imageHtml)return x("ok");x("error")}}(),()=>{a=!0,b&&URL.revokeObjectURL(b)}},[a,E,F,G]);let H=u?.title||u?.caption||`Figure / Table #${a}`,I=u?.caption||u?.legendText,J="ok"===w&&!q&&!!u?.imageHtml,K=(0,c.useMemo)(()=>(function({base:a,graphicId:b,label:c,htmlTable:d,resourceUrl:e}){let f=`${a}/utd/graphic/${b}`;return d?Object.freeze({kind:"table",title:c,source:"UpToDate",sourceUrl:`${f}/html`,element:d}):Object.freeze({kind:"image",title:c,source:"UpToDate",sourceUrl:f,resourceUrl:e&&!e.startsWith("blob:")?e:f})})({base:D,graphicId:a,label:H,htmlTable:J?y:null,resourceUrl:s}),[D,a,J,y,s,H]);function L(a){B(b=>n(b+a))}function M(){B(1),requestAnimationFrame(()=>{C.current?.scrollTo({top:0,left:0,behavior:"smooth"})})}let N=(0,c.useCallback)(a=>{B(n(a))},[]),O=(0,c.useCallback)(()=>{B(a=>a<1.8?n(1.8):1)},[]),P=(0,c.useCallback)(a=>{let b=a?.querySelector("table")||null;z(a=>a===b?a:b)},[]);(0,l.usePinchZoom)(C,{value:A,min:.65,max:3,onChange:N,ignoreSelector:".utd-graphic-controls"}),(0,l.useDoubleTap)(C,O,{ignoreSelector:".utd-graphic-controls"});let Q={"--utd-graphic-zoom":A,zoom:A};return(0,b.jsxs)(b.Fragment,{children:[(0,b.jsx)("div",{className:"utd-graphic-backdrop",onClick:p}),(0,b.jsxs)("section",{className:"utd-graphic-drawer",role:"dialog","aria-modal":"true","aria-label":H,onClick:a=>a.stopPropagation(),children:[(0,b.jsxs)("header",{className:"utd-graphic-header",children:[(0,b.jsxs)("div",{className:"utd-graphic-title-block",children:[(0,b.jsx)("span",{className:"utd-graphic-kicker",children:"UpToDate visual"}),(0,b.jsx)("h2",{children:H})]}),(0,b.jsxs)("div",{className:"utd-graphic-controls","aria-label":"Graphic controls",children:["ok"===w&&(!J||y)&&(0,b.jsx)(m.default,{descriptor:K,compact:!0}),(0,b.jsx)("button",{type:"button",onClick:()=>L(-.15),disabled:A<=.65,title:"Zoom out","aria-label":"Zoom out",children:(0,b.jsx)(j.ZoomOut,{size:16})}),(0,b.jsx)("input",{type:"range",min:.65,max:3,step:.05,value:A,onChange:a=>B(n(Number(a.target.value))),"aria-label":"Zoom"}),(0,b.jsx)("button",{type:"button",onClick:()=>L(.15),disabled:A>=3,title:"Zoom in","aria-label":"Zoom in",children:(0,b.jsx)(i.ZoomIn,{size:16})}),(0,b.jsx)("span",{className:"utd-graphic-zoom-readout",children:`${Math.round(100*A)}%`}),(0,b.jsx)("button",{type:"button",onClick:function(){B(.65),requestAnimationFrame(()=>{C.current?.scrollTo({top:0,left:0,behavior:"smooth"})})},title:"Overview zoom","aria-label":"Overview zoom",children:(0,b.jsx)(f.Maximize2,{size:16})}),(0,b.jsx)("button",{type:"button",onClick:M,title:"Reset view","aria-label":"Reset view",children:(0,b.jsx)(g.RotateCcw,{size:16})}),(0,b.jsx)("button",{type:"button",className:"utd-graphic-close",onClick:p,title:"Close","aria-label":"Close",children:(0,b.jsx)(h.X,{size:18})})]})]}),(0,b.jsxs)("div",{className:"utd-graphic-stage",ref:C,onWheel:function(a){(a.ctrlKey||a.metaKey)&&(a.preventDefault(),L(a.deltaY<0?.15:-.15))},children:["loading"===w&&(0,b.jsxs)("div",{className:"utd-graphic-state",children:[(0,b.jsx)(e.Loader2,{size:30,style:{animation:"utdGraphicSpin 1s linear infinite"}}),(0,b.jsx)("span",{children:"Decrypting graphic..."})]}),"error"===w&&(0,b.jsxs)("div",{className:"utd-graphic-state",children:[(0,b.jsx)("div",{className:"utd-graphic-state-icon",children:(0,b.jsx)(d,{size:30})}),(0,b.jsxs)("p",{children:["Graphic could not be loaded.",(0,b.jsx)("small",{children:"Try reopening it or restart MedOS if the local library is still starting."})]})]}),"ok"===w&&q&&(0,b.jsx)("div",{className:"utd-graphic-zoom-content",style:Q,"data-medos-media-pan-active":A>1?"true":void 0,children:(0,b.jsxs)("figure",{className:"utd-graphic-figure",children:[(0,b.jsx)("img",{src:q,alt:H,className:"utd-graphic-image",draggable:A<=1,"data-medos-media-title":H,"data-medos-media-source":"UpToDate","data-medos-media-source-url":E}),I&&(0,b.jsx)("figcaption",{children:I})]})}),J&&(0,b.jsx)("div",{className:"utd-graphic-zoom-content is-html",style:Q,"data-medos-media-pan-active":A>1?"true":void 0,children:(0,b.jsx)("div",{ref:P,className:"utd-graphic-html",dangerouslySetInnerHTML:{__html:u?.imageHtml||""}})})]})]}),(0,b.jsx)("style",{children:`
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
      `})]})}],51292)}];

//# sourceMappingURL=components_uptodate_GraphicDrawer_tsx_0cxoem3._.js.map