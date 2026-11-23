1:"$Sreact.fragment"
2:I[79520,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],""]
4:I[53815,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
5:"$Sreact.suspense"
6:I[90233,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
7:I[14642,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
8:I[46114,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
9:I[39756,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
a:I[37457,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
17:I[68027,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default",1]
:HL["/_next/static/chunks/0qljmqqa~9kfw.css","style"]
:HL["/_next/static/chunks/0.7yrdochqzsl.css","style"]
:HL["/fonts/fonts.css","style"]
3:T436,
(() => {
  try {
    const stored = window.localStorage.getItem("medos.theme");
    const theme = stored === "dark" || stored === "yellow" ? stored : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
  }
  try {
    // Pre-size the sidebar rail so a pinned-expanded sidebar doesn't shift
    // page content on first paint. Defaults to expanded; only reflows on a
    // real desktop (the sidebar overlays on hover everywhere else).
    var path = window.location.pathname;
    if (path === "/login" || path.indexOf("/login/") === 0) {
      // No sidebar on the lock screen — collapse the rail column entirely.
      document.documentElement.style.setProperty("--rail-w", "0px");
    } else {
      var sb = window.localStorage.getItem("medos.sidebar.expanded");
      var canPin = window.matchMedia("(min-width: 900px) and (pointer: fine)").matches;
      if (sb !== "0" && canPin) document.documentElement.style.setProperty("--rail-w", "210px");
    }
  } catch {}
})();
0:{"P":null,"c":["",""],"q":"","i":false,"f":[[["",{"children":["__PAGE__",{}]},"$undefined","$undefined",16],[["$","$1","c",{"children":[[["$","link","0",{"rel":"stylesheet","href":"/_next/static/chunks/0qljmqqa~9kfw.css","precedence":"next","crossOrigin":"$undefined","nonce":"$undefined"}],["$","link","1",{"rel":"stylesheet","href":"/_next/static/chunks/0.7yrdochqzsl.css","precedence":"next","crossOrigin":"$undefined","nonce":"$undefined"}],["$","script","script-0",{"src":"/_next/static/chunks/00ugfc1gdcckn.js","async":true,"nonce":"$undefined"}],["$","script","script-1",{"src":"/_next/static/chunks/0_4-mvbrxopw..js","async":true,"nonce":"$undefined"}],["$","script","script-2",{"src":"/_next/static/chunks/0so~9vx.p.42u.js","async":true,"nonce":"$undefined"}],["$","script","script-3",{"src":"/_next/static/chunks/0r8jb9pgnobuu.js","async":true,"nonce":"$undefined"}],["$","script","script-4",{"src":"/_next/static/chunks/0jlzl46bv1i3d.js","async":true,"nonce":"$undefined"}]],["$","html",null,{"lang":"en","data-medos-app":"true","suppressHydrationWarning":true,"children":[["$","head",null,{"children":[["$","$L2",null,{"id":"medos-loopback-guard","strategy":"beforeInteractive","dangerouslySetInnerHTML":{"__html":"\n(() => {\n  try {\n    if (window.location.hostname !== \"0.0.0.0\") return;\n    const target = new URL(window.location.href);\n    target.hostname = \"127.0.0.1\";\n    window.location.replace(target.toString());\n  } catch {}\n})();\n"}}],["$","$L2",null,{"id":"medos-theme-init","strategy":"beforeInteractive","dangerouslySetInnerHTML":{"__html":"$3"}}],["$","link",null,{"rel":"stylesheet","href":"/fonts/fonts.css"}]]}],["$","body",null,{"suppressHydrationWarning":true,"children":[["$","$L4",null,{"children":[["$","div",null,{"className":"shell-frame","children":[["$","$5",null,{"fallback":null,"children":["$","$L6",null,{}]}],["$","$L7",null,{}],["$","main",null,{"className":"app-main","style":{"gridRow":2,"gridColumn":2,"position":"relative","overflow":"hidden","display":"flex","flexDirection":"column"},"children":[["$","$L8",null,{}],["$","$L9",null,{"parallelRouterKey":"children","error":"$undefined","errorStyles":"$undefined","errorScripts":"$undefined","template":["$","$La",null,{}],"templateStyles":"$undefined","templateScripts":"$undefined","notFound":[[["$","title",null,{"children":"404: This page could not be found."}],["$","div",null,{"style":{"fontFamily":"system-ui,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\"","height":"100vh","textAlign":"center","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center"},"children":["$","div",null,{"children":[["$","style",null,{"dangerouslySetInnerHTML":{"__html":"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}"}}],["$","h1",null,{"className":"next-error-h1","style":{"display":"inline-block","margin":"0 20px 0 0","padding":"0 23px 0 0","fontSize":24,"fontWeight":500,"verticalAlign":"top","lineHeight":"49px"},"children":404}],["$","div",null,{"style":{"display":"inline-block"},"children":"$Lb"}]]}]}]],[]],"forbidden":"$undefined","unauthorized":"$undefined"}]]}],"$Lc","$Ld","$Le","$Lf"]}],"$L10","$L11","$L12"]}],"$L13","$L14"]}]]}]]}],{"children":["$L15",{},null,false,null]},null,false,null],"$L16",false]],"m":"$undefined","G":["$17",["$L18","$L19"]],"S":true,"h":null,"s":"$undefined","l":"$undefined","p":"$undefined","d":"$undefined","b":"6NVGquVwiX81LR4sRXga4"}
1a:I[3802,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
1b:I[45291,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
1c:I[55442,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
1d:I[55647,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
1e:I[32571,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
1f:I[99288,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
20:I[91744,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"default"]
21:I[47257,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"ClientPageRoot"]
22:I[31713,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js","/_next/static/chunks/0~ik8elrq99~8.js","/_next/static/chunks/0x_fwzpqkx2bj.js","/_next/static/chunks/16k0w_r5709xe.js"],"default"]
25:I[97367,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"OutletBoundary"]
27:I[97367,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"ViewportBoundary"]
29:I[97367,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"MetadataBoundary"]
b:["$","h2",null,{"style":{"fontSize":14,"fontWeight":400,"lineHeight":"49px","margin":0},"children":"This page could not be found."}]
c:["$","$L1a",null,{}]
d:["$","$L1b",null,{}]
e:["$","$L1c",null,{}]
f:["$","$L1d",null,{}]
10:["$","$L1e",null,{}]
11:["$","$L1f",null,{}]
12:["$","$L20",null,{}]
13:["$","$L2",null,{"id":"medos-media-interop","src":"/medos-media-interop.mjs","type":"module","strategy":"afterInteractive"}]
14:["$","$L2",null,{"src":"/calc-runtime.js?v=20260512-mdcalc-live-v5","strategy":"afterInteractive"}]
15:["$","$1","c",{"children":[["$","$L21",null,{"Component":"$22","serverProvidedParams":{"searchParams":{},"params":{},"promises":["$@23","$@24"]}}],[["$","script","script-0",{"src":"/_next/static/chunks/0~ik8elrq99~8.js","async":true,"nonce":"$undefined"}],["$","script","script-1",{"src":"/_next/static/chunks/0x_fwzpqkx2bj.js","async":true,"nonce":"$undefined"}],["$","script","script-2",{"src":"/_next/static/chunks/16k0w_r5709xe.js","async":true,"nonce":"$undefined"}]],["$","$L25",null,{"children":["$","$5",null,{"name":"Next.MetadataOutlet","children":"$@26"}]}]]}]
16:["$","$1","h",{"children":[null,["$","$L27",null,{"children":"$L28"}],["$","div",null,{"hidden":true,"children":["$","$L29",null,{"children":["$","$5",null,{"name":"Next.Metadata","children":"$L2a"}]}]}],null]}]
18:["$","link","0",{"rel":"stylesheet","href":"/_next/static/chunks/0qljmqqa~9kfw.css","precedence":"next","crossOrigin":"$undefined","nonce":"$undefined"}]
19:["$","link","1",{"rel":"stylesheet","href":"/_next/static/chunks/0.7yrdochqzsl.css","precedence":"next","crossOrigin":"$undefined","nonce":"$undefined"}]
23:{}
24:"$15:props:children:0:props:serverProvidedParams:params"
28:[["$","meta","0",{"charSet":"utf-8"}],["$","meta","1",{"name":"viewport","content":"width=device-width, initial-scale=1"}]]
2b:I[27201,["/_next/static/chunks/00ugfc1gdcckn.js","/_next/static/chunks/0_4-mvbrxopw..js","/_next/static/chunks/0so~9vx.p.42u.js","/_next/static/chunks/0r8jb9pgnobuu.js","/_next/static/chunks/0jlzl46bv1i3d.js"],"IconMark"]
26:null
2a:[["$","title","0",{"children":"MedOS — Clinical Intelligence Platform"}],["$","meta","1",{"name":"description","content":"AMBOSS-style medical reference: AI chat, 3D anatomy, disease library, clinical calculators"}],["$","link","2",{"rel":"icon","href":"/favicon.ico?favicon.0x3dzn~oxb6tn.ico","sizes":"256x256","type":"image/x-icon"}],["$","$L2b","3",{}]]
