export function renderWebConsole(input: { csrfToken: string; nonce: string }): string {
  const csrf = html(input.csrfToken);
  const nonce = html(input.nonce);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="csrf-token" content="${csrf}">
  <link rel="icon" href="data:,">
  <title>lark-pi-bridge 本地控制台</title>
  <style nonce="${nonce}">
    :root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--panel-soft:#f9fbff;--text:#172033;--heading:#111827;--muted:#667085;--subtle:#98a2b3;--line:#e4e7ec;--line-strong:#d0d5dd;--input:#fff;--brand:#4f46e5;--brand-soft:#eef2ff;--cyan-soft:#ecfeff;--ok:#087443;--ok-soft:#ecfdf3;--warn:#b54708;--warn-soft:#fff7ed;--error:#c4320a;--error-soft:#fff4ed;--code:#f8fafc;--json:#0b1020;--json-text:#dbeafe;--shadow:0 18px 50px #10182814,0 2px 8px #1018280a;--radius:18px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-height:100vh;background:radial-gradient(circle at top left,#e0e7ff 0,var(--bg) 30%,#f7f9fc 100%);color:var(--text);line-height:1.55}.shell{width:min(1320px,calc(100% - 40px));margin:0 auto;padding:34px 0 46px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:22px}.eyebrow{display:inline-flex;align-items:center;border:1px solid #c7d2fe;background:var(--brand-soft);color:#3730a3;border-radius:999px;padding:5px 11px;font-weight:700;font-size:12px}.hero h1{font-size:34px;letter-spacing:-.04em;line-height:1.08;margin:12px 0 8px;color:var(--heading)}.hero p{margin:0;max-width:780px;color:var(--muted)}.page-stack{display:grid;gap:18px}.card{min-width:0;background:linear-gradient(180deg,var(--panel),var(--panel-soft));border:1px solid #ffffffa8;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}.card.flat{box-shadow:none;border-color:var(--line);background:var(--panel)}.card h2,.card h3{margin:0;color:var(--heading)}.card h2{font-size:18px;letter-spacing:-.02em}.card h3{font-size:15px}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}.section-head p{margin:4px 0 0;color:var(--muted);font-size:13px}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;white-space:nowrap;background:#f2f4f7;color:#344054}.badge.active{background:var(--ok-soft);color:var(--ok)}.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.brand{background:var(--brand-soft);color:#3730a3}.overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.stat{min-width:0;border:1px solid var(--line);background:var(--input);border-radius:14px;padding:12px 14px}.stat span{display:block;color:var(--muted);font-size:12px}.stat strong{display:block;margin-top:4px;font-size:18px;letter-spacing:-.025em;color:var(--heading);overflow-wrap:anywhere}.global-note{margin-top:12px;border-left:3px solid #a5b4fc;background:var(--brand-soft);border-radius:10px;padding:10px 12px;color:var(--muted);font-size:13px}.profile-switch-grid{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,320px) auto minmax(190px,240px) auto;gap:12px;align-items:end}.profile-context{min-width:0}.profile-context .label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.profile-context .name{display:flex;gap:8px;align-items:center;margin-top:4px;font-size:22px;font-weight:780;letter-spacing:-.03em;color:var(--heading)}.profile-context .note{margin-top:5px;color:var(--muted);font-size:12px}.result{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;border-radius:14px;border:1px solid var(--line);background:var(--panel);padding:13px 15px;margin:0}.result:empty{display:none}.result.ok{border-color:#abefc6;background:var(--ok-soft);color:var(--ok)}.result.error{border-color:#f7b27a;background:var(--error-soft);color:var(--error)}.runtime-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center}.runtime-stats{display:grid;grid-template-columns:repeat(2,minmax(0,220px));gap:10px}.runtime-actions,.action-row{display:flex;gap:10px;justify-content:flex-start;align-items:center;flex-wrap:wrap}.runtime-actions{justify-content:flex-end}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.wide{grid-column:1 / -1}.field{display:grid;gap:6px;min-width:0}.field label{font-size:12px;font-weight:700;color:var(--muted)}.form-grid{display:grid;gap:12px;align-items:end}.workspace-form{grid-template-columns:minmax(150px,220px) minmax(0,1fr)}.permission-form{grid-template-columns:repeat(2,minmax(0,1fr))}.transport-form{grid-template-columns:minmax(0,1fr)}.model-form-primary{grid-template-columns:minmax(140px,.7fr) minmax(180px,1fr) minmax(260px,1.5fr)}.model-form-secondary{grid-template-columns:repeat(2,minmax(180px,260px))}.form-block{display:grid;gap:12px}.divider{height:1px;background:var(--line);margin:16px 0}.help,.muted{color:var(--muted)}.help{font-size:13px;margin:12px 0 0}.hint{border-left:3px solid #a5b4fc;background:var(--brand-soft);border-radius:10px;padding:10px 12px;color:var(--muted);font-size:13px}.workspace-list{display:grid;gap:8px;margin-bottom:16px}.workspace-item{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid var(--line);background:var(--input);border-radius:12px;padding:10px 12px}.workspace-alias{font-weight:750;color:var(--heading)}.workspace-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.workspace-flags{display:flex;gap:6px;justify-content:flex-end}.source-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.source-value{font-size:16px!important}.model-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}.read-only-notice{margin-bottom:0}.advanced summary{cursor:pointer;font-weight:750;color:var(--heading);list-style-position:inside}.advanced[open] summary{margin-bottom:14px}.json{white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;margin:0;padding:13px;border:1px solid var(--line);border-radius:14px;background:var(--json);color:var(--json-text);font-size:12px}button,input,select{font:inherit;border-radius:11px;border:1px solid var(--line-strong);background:var(--input);color:var(--text)}input,select{display:block;width:100%;min-width:0;padding:10px 11px;min-height:42px}input:focus,select:focus{outline:3px solid #6366f133;border-color:#818cf8}button{flex:0 0 auto;padding:9px 13px;height:42px;cursor:pointer;font-weight:700;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}button:hover{transform:translateY(-1px);box-shadow:0 8px 20px #10182814;border-color:#b8c0cc}button.primary{border-color:#4f46e5;background:linear-gradient(135deg,var(--brand),#7c3aed);color:#fff}button.secondary{border-color:#67e8f9;background:var(--cyan-soft);color:#155e75}button.danger{border-color:#fed7aa;background:var(--warn-soft);color:#9a3412}button:disabled{cursor:not-allowed;opacity:.55;transform:none;box-shadow:none}code{border:1px solid var(--line);background:var(--code);border-radius:6px;padding:1px 5px}.empty{color:var(--subtle)}@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b1020;--panel:#111827;--panel-soft:#0f172a;--text:#eef2ff;--heading:#f8fafc;--muted:#a4adbd;--subtle:#697386;--line:#263244;--line-strong:#475467;--input:#111827;--brand-soft:#1e1b4b;--cyan-soft:#083344;--ok:#86efac;--ok-soft:#052e16;--warn:#fdba74;--warn-soft:#431407;--error:#fda29b;--error-soft:#451a13;--code:#0f172a;--shadow:0 18px 50px #0008}body{background:radial-gradient(circle at top left,#1e1b4b 0,#0b1020 35%,#0f172a 100%)}.card{border-color:#ffffff12}.badge{background:#1f2937;color:#d1d5db}.badge.brand{background:#1e1b4b;color:#c7d2fe}.eyebrow{background:#1e1b4b;border-color:#3730a3;color:#c7d2fe}button.secondary{color:#a5f3fc}.global-note,.hint{border-left-color:#6366f1}}@media (max-width:1100px){.profile-switch-grid{grid-template-columns:minmax(200px,1fr) minmax(190px,280px) auto}.scope-field,.scope-action{grid-row:2}.scope-field{grid-column:2}.scope-action{grid-column:3}.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.model-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:900px){.shell{width:min(100% - 24px,760px);padding-top:24px}.hero,.runtime-grid{display:grid;grid-template-columns:1fr}.overview-grid,.profile-switch-grid,.settings-grid,.workspace-form,.permission-form,.model-form-primary,.model-form-secondary,.source-grid{grid-template-columns:1fr}.scope-field,.scope-action{grid-row:auto;grid-column:auto}.wide{grid-column:auto}.runtime-actions{justify-content:flex-start}.workspace-item{grid-template-columns:1fr}.workspace-flags{justify-content:flex-start}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div>
        <span class="eyebrow">Local Control Plane</span>
        <h1>lark-pi-bridge 本地控制台</h1>
        <p>按“全局概览 → Profile 切换 → 运行态 → Profile 功能”管理本地 Bridge。页面仅限本机回环，不显示或接收 App Secret 与 provider key。</p>
      </div>
      <button id="refresh" class="primary">刷新全部</button>
    </header>

    <div class="page-stack">
      <section class="card" aria-labelledby="globalTitle">
        <div class="section-head"><div><h2 id="globalTitle">全局概览</h2><p>这些信息不随正在编辑的 Profile 改变。</p></div><span class="badge brand">Global</span></div>
        <div class="overview-grid">
          <div class="stat"><span>Active profile</span><strong id="activeProfile">—</strong></div>
          <div class="stat"><span>Profile count</span><strong id="profileCount">—</strong></div>
          <div class="stat"><span>Loopback only</span><strong id="loopback">—</strong></div>
          <div class="stat"><span>Web registration</span><strong id="registrationState">—</strong></div>
        </div>
        <div class="global-note" id="registration">注册状态加载中…</div>
      </section>

      <section class="card" aria-labelledby="profileSwitchTitle">
        <div class="section-head"><div><h2 id="profileSwitchTitle">Profile 切换</h2><p>选择正在编辑的 Profile，并管理其 Pi 配置来源。</p></div><span class="badge" id="profileScopeBadge">Pi scope · —</span></div>
        <div class="profile-switch-grid">
          <div class="profile-context">
            <div class="label">当前正在编辑</div>
            <div class="name"><span id="selectedProfileName">—</span><span class="badge active" id="selectedActiveBadge" hidden>active</span></div>
            <div class="note">Session 与 Bridge system prompt 始终保持 Profile 隔离。</div>
          </div>
          <div class="field"><label for="profile">Profile</label><select id="profile" aria-label="选择要编辑的 profile"></select></div>
          <button id="activateProfile">设为 active</button>
          <div class="field scope-field"><label for="piConfigScope">Pi 配置来源</label><select id="piConfigScope"><option value="user">user · ~/.pi/agent</option><option value="profile">profile · 独立配置</option></select></div>
          <button id="savePiConfigScope" class="secondary scope-action">保存来源</button>
        </div>
      </section>

      <pre id="result" class="result" role="status" aria-live="polite"></pre>

      <section class="card" aria-labelledby="runtimeTitle">
        <div class="section-head"><div><h2 id="runtimeTitle">所选 Profile 运行态</h2><p>这里是 foreground runtime 的 PID 状态，不冒充 managed service 状态。</p></div><span class="badge" id="runtimeBadge">Runtime</span></div>
        <div class="runtime-grid">
          <div class="runtime-stats" id="runtimeSummary"><span class="empty">加载中…</span></div>
          <div class="runtime-actions">
            <button id="doctor">安全 doctor</button>
            <button id="providerDoctor" class="secondary">Provider TCP</button>
            <button id="runtimeRefresh" class="secondary">刷新运行时配置</button>
          </div>
        </div>
      </section>

      <div class="settings-grid">
        <section class="card wide" aria-labelledby="workspaceTitle">
          <div class="section-head"><div><h2 id="workspaceTitle">Workspace</h2><p>查看 alias、默认项与目录可用状态；修改保存到所选 Profile。</p></div><span class="badge" data-profile-chip>Profile</span></div>
          <div id="workspaceList" class="workspace-list"><span class="empty">加载中…</span></div>
          <div class="form-block">
            <div class="form-grid workspace-form">
              <div class="field"><label for="alias">Alias</label><input id="alias" placeholder="如 x-connect"></div>
              <div class="field"><label for="workspace">绝对目录</label><input id="workspace" placeholder="已存在的绝对目录"></div>
            </div>
            <div class="action-row">
              <button id="setWorkspace" class="primary">保存 alias</button>
              <button id="setDefaultWorkspace">设为默认</button>
              <button id="removeWorkspace" class="danger">删除 alias</button>
            </div>
          </div>
          <p class="help">Web 不存在聊天 scope，因此不展示“当前 scope workspace”。default 是保留 alias。</p>
        </section>

        <section class="card" aria-labelledby="permissionTitle">
          <div class="section-head"><div><h2 id="permissionTitle">权限与 Transport</h2><p>配置工具权限上限和 Pi 启动方式。</p></div><span class="badge" data-profile-chip>Profile</span></div>
          <div class="form-block">
            <div class="form-grid permission-form">
              <div class="field"><label for="defaultAccess">defaultAccess</label><select id="defaultAccess"><option>read-only</option><option>full</option></select></div>
              <div class="field"><label for="maxAccess">maxAccess</label><select id="maxAccess"><option>read-only</option><option>full</option></select></div>
            </div>
            <div class="action-row"><button id="savePermissions" class="primary">保存权限</button></div>
          </div>
          <div class="divider"></div>
          <div class="form-block">
            <div class="form-grid transport-form"><div class="field"><label for="transport">Transport</label><select id="transport"><option>spawn-per-turn</option><option>rpc</option></select></div></div>
            <div class="action-row"><button id="saveTransport">保存 transport</button></div>
          </div>
          <div class="divider"></div>
          <div class="form-block">
            <div class="field"><label for="mentionOptionalChat">免 @ 群 chat_id</label><select id="mentionOptionalChat"></select></div>
            <div class="action-row">
              <button id="enableMentionOptional" class="danger">设为无需 @</button>
              <button id="disableMentionOptional">恢复必须 @</button>
            </div>
          </div>
          <p class="help">仅可选择已授权的 allowedChats；无需 @ 会让该群全部普通消息都可能触发 Pi。非 workspace 配置变更后需刷新运行时。</p>
        </section>

        <section class="card" aria-labelledby="sourceTitle">
          <div class="section-head"><div><h2 id="sourceTitle">Pi 配置来源</h2><p>配置资源与会话数据采用不同隔离边界。</p></div><span class="badge" id="sourceBadge">—</span></div>
          <div class="source-grid">
            <div class="stat"><span>Configuration</span><strong class="source-value" id="configSource">—</strong></div>
            <div class="stat"><span>Session &amp; Bridge prompt</span><strong class="source-value">Profile-local</strong></div>
          </div>
          <div class="hint" id="sourceHelp">加载中…</div>
        </section>

        <section class="card wide" aria-labelledby="modelTitle">
          <div class="section-head"><div><h2 id="modelTitle">Provider / Model</h2><p id="modelSubtitle">加载模型状态…</p></div><span class="badge" id="modelStateBadge">—</span></div>
          <div class="model-summary">
            <div class="stat"><span>State</span><strong id="modelState">—</strong></div>
            <div class="stat"><span>Provider</span><strong id="modelProvider">—</strong></div>
            <div class="stat"><span>Model</span><strong id="modelName">—</strong></div>
            <div class="stat"><span>Thinking</span><strong id="modelThinking">—</strong></div>
          </div>
          <div id="userModelNotice" class="hint read-only-notice" hidden>user scope 为只读：新 session 跟随本机 Pi 默认配置。请在本机 Pi 中修改，或先将此 Profile 切换到 profile scope。</div>
          <div id="profileModelEditor" class="form-block" hidden>
            <div class="form-grid model-form-primary">
              <div class="field"><label for="provider">Provider</label><input id="provider" placeholder="provider"></div>
              <div class="field"><label for="model">Model</label><input id="model" placeholder="model"></div>
              <div class="field"><label for="endpoint">Endpoint</label><input id="endpoint" placeholder="HTTPS 或 loopback HTTP"></div>
            </div>
            <div class="form-grid model-form-secondary">
              <div class="field"><label for="api">API</label><select id="api"><option>openai-responses</option><option>openai-completions</option><option>anthropic-messages</option></select></div>
              <div class="field"><label for="modelInput">输入能力</label><select id="modelInput"><option value="text">仅文本</option><option value="text,image">文本与图片</option></select></div>
            </div>
            <div class="action-row"><button id="saveModel" class="primary">保存（不含密钥）</button></div>
            <p class="help">profile scope 只写 Profile 私有 Pi 配置。密钥仍必须通过终端私有文件导入。</p>
          </div>
        </section>

        <details class="card flat advanced wide">
          <summary>高级：非机密 Profile JSON</summary>
          <pre id="profileView" class="json">加载中…</pre>
        </details>

        <section class="card flat wide">
          <h2>注册与服务</h2>
          <p class="help">飞书 device-code 注册必须在本机终端执行 <code>lark-pi-bridge init --register</code>；持久 service 请使用 CLI <code>service …</code> 命令。</p>
        </section>
      </div>
    </div>
  </main>

<script nonce="${nonce}">
const csrf=document.querySelector('meta[name="csrf-token"]').content;
const $=id=>document.getElementById(id);
let selected='';
let profiles=[];
async function api(path,body){const headers={'x-csrf-token':csrf};if(body!==undefined){headers['content-type']='application/json';headers['x-request-id']=crypto.randomUUID()}const response=await fetch(path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});const value=await response.json();if(!response.ok)throw new Error(value.error||('HTTP '+response.status));return value}
function show(value,error=false){$('result').className='result '+(error?'error':'ok');$('result').textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
function text(value,fallback='—'){return value===undefined||value===null||value===''?fallback:String(value)}
function setBadge(element,status){element.textContent=status;element.className='badge '+(status==='running'||status==='ready'||status==='available'||status==='follow_pi_default'||status==='explicit_profile_model'?'active':status==='stopped'||status==='degraded'||status==='unavailable'||status==='invalid'?'warn':'')}
function renderGlobal(status){$('activeProfile').textContent=text(status.activeProfile);$('profileCount').textContent=text(status.profileCount);$('loopback').textContent=status.loopback?'yes':'no';const registration=status.registration||{};$('registrationState').textContent=registration.available?'available':'CLI only';$('registration').textContent='注册：'+text(registration.available?'available':registration.reason,'—')}
function renderRuntime(status){const local=status.localForeground||{};const runtime=local.runtime||{};const state=!local.running?(local.pid?'stale':'stopped'):(runtime.health||'degraded');setBadge($('runtimeBadge'),state);$('runtimeSummary').textContent='';const rows=[['Runtime state',state],['PID',local.pid],['Channel',runtime.channel&&runtime.channel.state],['Reconnect attempts',runtime.channel&&runtime.channel.reconnectAttempts],['Last connected',runtime.channel&&runtime.channel.lastConnectTime?new Date(runtime.channel.lastConnectTime).toLocaleString():undefined],['Last inbound',runtime.lastInboundTime?new Date(runtime.lastInboundTime).toLocaleString():undefined]];for(const row of rows){const node=document.createElement('div');node.className='stat';const label=document.createElement('span');label.textContent=row[0];const value=document.createElement('strong');value.textContent=text(row[1]);node.append(label,value);$('runtimeSummary').append(node)}}
function renderWorkspaces(workspaces){$('workspaceList').textContent='';const named=workspaces.named||{};const aliases=Object.keys(named).sort();if(!aliases.length){const empty=document.createElement('span');empty.className='empty';empty.textContent='尚未注册命名 workspace。';$('workspaceList').append(empty);return}for(const alias of aliases){const item=document.createElement('div');item.className='workspace-item';const name=document.createElement('div');name.className='workspace-alias';name.textContent=alias;const path=document.createElement('div');path.className='workspace-path';path.textContent=named[alias];path.title=named[alias];const flags=document.createElement('div');flags.className='workspace-flags';if(workspaces.defaultAlias===alias){const badge=document.createElement('span');badge.className='badge active';badge.textContent='default';flags.append(badge)}const availability=document.createElement('span');const unavailable=(workspaces.unavailable||[]).includes(alias);availability.className='badge '+(unavailable?'warn':'');availability.textContent=unavailable?'unavailable':'available';flags.append(availability);item.append(name,path,flags);$('workspaceList').append(item)}}
function renderProfile(value){$('profileView').textContent=JSON.stringify(value,null,2);$('selectedProfileName').textContent=value.name;$('selectedActiveBadge').hidden=!value.active;for(const chip of document.querySelectorAll('[data-profile-chip]'))chip.textContent='Profile · '+value.name;$('defaultAccess').value=value.permissions.defaultAccess;$('maxAccess').value=value.permissions.maxAccess;$('transport').value=value.preferences.transport;const mentionSelect=$('mentionOptionalChat');mentionSelect.textContent='';const optional=value.access.mentionOptionalChats||[];for(const chatId of value.access.allowedChats||[]){const option=document.createElement('option');option.value=chatId;option.textContent=chatId+(optional.includes(chatId)?' · 无需 @':' · 必须 @');mentionSelect.append(option)}$('enableMentionOptional').disabled=!mentionSelect.options.length;$('disableMentionOptional').disabled=!mentionSelect.options.length;const scope=value.preferences.piConfigScope;$('piConfigScope').value=scope;$('profileScopeBadge').textContent='Pi scope · '+scope;setBadge($('sourceBadge'),scope);$('configSource').textContent=scope==='user'?'User Pi · ~/.pi/agent':'Profile-local Pi';$('sourceHelp').textContent=scope==='user'?'Bridge 只读共享用户 Pi 的认证、settings、extensions、skills 与其他资源；不会通过管理面修改 ~/.pi/agent。':'此 Profile 使用独立 Pi 配置目录，可通过 Bridge 管理 profile-local provider/model。';renderWorkspaces(value.workspaces||{});const model=value.model||{};setBadge($('modelStateBadge'),text(model.state));$('modelState').textContent=text(model.state);$('modelProvider').textContent=text(model.providerId);$('modelName').textContent=text(model.modelId);$('modelThinking').textContent=text(model.thinkingLevel);const userScope=scope==='user';$('userModelNotice').hidden=!userScope;$('profileModelEditor').hidden=userScope;$('modelSubtitle').textContent=userScope?'只读展示用户 Pi 的新 session 默认选择。':'编辑 Profile 私有 provider/model 声明。';$('provider').value=model.providerId||'';$('model').value=model.modelId||'';$('endpoint').value=model.endpoint||'';$('api').value=model.api||'openai-responses';$('modelInput').value=(model.input||['text']).includes('image')?'text,image':'text'}
async function load(){try{const status=await api('/api/status');renderGlobal(status);const data=await api('/api/profiles');profiles=data.profiles||[];const previous=selected;$('profile').textContent='';for(const item of profiles){const option=document.createElement('option');option.value=item.name;option.textContent=item.name+(item.active?' (active)':'');$('profile').append(option)}if(previous&&profiles.some(item=>item.name===previous))$('profile').value=previous;selected=$('profile').value;await loadProfile()}catch(error){show(String(error),true)}}
async function loadProfile(){try{selected=$('profile').value;const value=await api('/api/profile?profile='+encodeURIComponent(selected));renderProfile(value);const status=await api('/api/status?profile='+encodeURIComponent(selected));renderRuntime(status)}catch(error){show(String(error),true)}}
async function mutate(path,body){try{const value=await api(path+'?profile='+encodeURIComponent(selected),body);show(value);await load()}catch(error){show(String(error),true)}}
$('refresh').onclick=load;$('profile').onchange=loadProfile;$('activateProfile').onclick=()=>mutate('/api/profile/activate',{profile:selected});$('savePiConfigScope').onclick=()=>mutate('/api/pi-config-scope',{scope:$('piConfigScope').value});$('doctor').onclick=()=>mutate('/api/doctor',{});$('providerDoctor').onclick=()=>mutate('/api/doctor',{checkProvider:true});$('setWorkspace').onclick=()=>mutate('/api/workspaces/set',{alias:$('alias').value,path:$('workspace').value});$('setDefaultWorkspace').onclick=()=>mutate('/api/workspaces/default',{alias:$('alias').value});$('removeWorkspace').onclick=()=>mutate('/api/workspaces/remove',{alias:$('alias').value});$('savePermissions').onclick=()=>mutate('/api/permissions',{defaultAccess:$('defaultAccess').value,maxAccess:$('maxAccess').value});$('saveTransport').onclick=()=>mutate('/api/transport',{transport:$('transport').value});$('enableMentionOptional').onclick=()=>mutate('/api/mention-optional',{chatId:$('mentionOptionalChat').value,enabled:true});$('disableMentionOptional').onclick=()=>mutate('/api/mention-optional',{chatId:$('mentionOptionalChat').value,enabled:false});$('runtimeRefresh').onclick=()=>mutate('/api/runtime/refresh',{});$('saveModel').onclick=()=>mutate('/api/model',{providerId:$('provider').value,modelId:$('model').value,baseUrl:$('endpoint').value,api:$('api').value,input:$('modelInput').value});load();
</script>
</body>
</html>`;
}

function html(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
