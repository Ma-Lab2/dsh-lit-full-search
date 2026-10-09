/**
 * dsh-lit-full-search Web 客户端（lazy-CJS，经 __ModuleLoader__ 注入）。
 *
 * 槽位设计（与 DSH 0.2.0-rc 平台契约逐条核对过）：
 *  1. main（keyed，root 级）—— id `lit-full-search-settings` 的设置主面板：
 *     侧栏 panellist 条目点击必然 `selectPanel(id)` 且要求该 id 已在 main
 *     keyed slot 注册（未注册会 throw），因此设置页必须注册为真正的面板
 *     （与 plugins / schedules 面板同一机制）。
 *  2. sidebar.panellist —— 「全面搜索设置」图标（id 与 main 面板相同，
 *     order 20：plugins=0、schedules=10，紧贴定时任务之下）。条目组件只渲染
 *     装饰字形（props {size, active}），点击/选中态由 sidebar 的 PanelRow 负责。
 *
 * composer dock 的「全面搜索…相关文献」快捷 chip 已按用户要求移除。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lit-full-search',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var CSS = [
      '.lfs-page { box-sizing:border-box; height:100%; overflow:auto; padding:32px 24px 72px; color:var(--ds-color-text, #d7dbe0); font-size:13px; line-height:1.55; }',
      '.lfs-shell { max-width:680px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }',
      '.lfs-head { display:flex; align-items:center; gap:10px; }',
      '.lfs-head-icon { display:flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:9px; background:rgba(79,142,247,.14); color:#7fb2ff; flex:none; }',
      '.lfs-head-title { font-size:17px; font-weight:600; letter-spacing:.01em; }',
      '.lfs-head-sub { margin-top:2px; font-size:12px; color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-head-sub code { padding:1px 5px; border-radius:4px; background:var(--ds-color-surface-hover, #2a2e35); font-size:11px; }',
      '.lfs-section { border:1px solid var(--ds-color-border, #3a3f47); border-radius:12px; background:var(--ds-color-surface, #23262c); overflow:hidden; }',
      '.lfs-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:13px 18px; border-bottom:1px solid var(--ds-color-border, #3a3f47); background:rgba(255,255,255,.015); }',
      '.lfs-section-title { font-size:13px; font-weight:600; }',
      '.lfs-section-note { font-size:11px; color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-section-body { display:flex; flex-direction:column; gap:16px; padding:18px; }',
      '.lfs-field { display:flex; flex-direction:column; gap:5px; }',
      '.lfs-label-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }',
      '.lfs-label { font-size:12px; font-weight:500; color:var(--ds-color-text, #d7dbe0); }',
      '.lfs-input { width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid var(--ds-color-border, #3a3f47); border-radius:7px; background:var(--ds-color-surface-hover, #2a2e35); color:var(--ds-color-text, #d7dbe0); font-size:13px; transition:border-color .12s, box-shadow .12s; }',
      '.lfs-input::placeholder { color:var(--ds-color-text-dim, #9aa1ab); opacity:.7; }',
      '.lfs-input:focus { outline:none; border-color:#4f8ef7; box-shadow:0 0 0 3px rgba(79,142,247,.16); }',
      '.lfs-input:disabled { opacity:.55; cursor:not-allowed; }',
      '.lfs-input.num { width:120px; text-align:right; font-variant-numeric:tabular-nums; }',
      '.lfs-hint { font-size:11px; color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(270px, 1fr)); gap:16px; }',
      '.lfs-num-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }',
      '.lfs-badge { display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border-radius:999px; font-size:11px; line-height:1.7; white-space:nowrap; }',
      '.lfs-badge.ok { background:rgba(95,209,124,.14); color:#5fd17c; }',
      '.lfs-badge.missing { background:rgba(224,161,58,.14); color:#e0a13a; }',
      '.lfs-badge.env { background:rgba(255,255,255,.06); color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-linkbtn { padding:0; border:none; background:none; color:#7fb2ff; font-size:11px; cursor:pointer; }',
      '.lfs-linkbtn:hover { color:#a8cbff; text-decoration:underline; }',
      '.lfs-linkbtn.danger { color:#f2777a; }',
      '.lfs-linkbtn.danger:hover { color:#ff9a9c; }',
      '.lfs-pending { font-size:11px; color:#e0a13a; }',
      '.lfs-bar { position:sticky; bottom:0; display:flex; align-items:center; gap:12px; padding:12px 2px 2px; background:linear-gradient(to top, var(--ds-color-bg, #1b1e23) 55%, transparent); }',
      '.lfs-btn { padding:8px 16px; border:1px solid transparent; border-radius:7px; cursor:pointer; font-size:13px; font-weight:500; }',
      '.lfs-btn-primary { background:#4f8ef7; color:#fff; }',
      '.lfs-btn-primary:hover:not(:disabled) { background:#3d7ce8; }',
      '.lfs-btn:disabled { opacity:.5; cursor:not-allowed; }',
      '.lfs-btn-ghost { background:transparent; border-color:var(--ds-color-border, #3a3f47); color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-btn-ghost:hover:not(:disabled) { color:var(--ds-color-text, #d7dbe0); border-color:#5a616b; }',
      '.lfs-msg { font-size:12px; }',
      '.lfs-msg.ok { color:#5fd17c; }',
      '.lfs-msg.err { color:#f2777a; }',
      '.lfs-state { padding:26px 18px; text-align:center; font-size:12px; color:var(--ds-color-text-dim, #9aa1ab); }',
      '.lfs-diag-list { display:flex; flex-direction:column; gap:8px; }',
      '.lfs-diag-row { display:flex; align-items:baseline; gap:8px; }',
      '.lfs-diag-label { font-size:12px; font-weight:500; white-space:nowrap; }',
      '.lfs-diag-detail { font-size:11px; color:var(--ds-color-text-dim, #9aa1ab); }',
    ].join('\n');

    // ---- 字段元数据（与 lib/config.js 的 BUDGET_RANGE / DEFAULT_BUDGET 保持一致）----
    var DEFAULT_BUDGET = { searchLimit: 10, citedByLimit: 25, zoteroLimit: 20, abstractChars: 2000 };

    var BUDGET_FIELDS = [
      { key: 'searchLimit', label: 'lit_search 每批条数', min: 1, max: 25, step: 1, hint: '关键词检索一次返回的题录上限（1–25）' },
      { key: 'citedByLimit', label: 'lit_cited_by 每批条数', min: 1, max: 25, step: 1, hint: '被引滚雪球一次返回的题录上限（1–25）' },
      { key: 'zoteroLimit', label: 'zotero_search 每批条数', min: 1, max: 100, step: 1, hint: '本地 Zotero 库检索返回的条目上限（1–100）' },
      { key: 'abstractChars', label: 'lit_abstract 摘要字符上限', min: 200, max: 100000, step: 100, hint: '单篇摘要截断长度（200–100000）' },
    ];

    var SECRET_FIELDS = [
      {
        key: 'openAlexApiKey',
        label: 'OpenAlex API Key',
        env: 'LIT_SEARCH_OPENALEX_API_KEY',
        hint: '可选。留空则回落到环境变量，再回落到匿名访问。',
      },
      {
        key: 's2ApiKey',
        label: 'Semantic Scholar API Key',
        env: 'LIT_SEARCH_S2_API_KEY',
        hint: '可选。设置后 lit_search 同时检索 Semantic Scholar 并按 DOI 去重合并；留空回落到环境变量，仅检索 OpenAlex。',
      },
      {
        key: 'zoteroKey',
        label: 'Zotero API Key',
        env: 'LIT_SEARCH_ZOTERO_KEY',
        hint: 'zotero_save 建条目需要；只读检索不需要。',
      },
    ];

    // ---- DSH 客户端 API 基址（与 Host 路由同源）----
    function apiUrl() {
      var base = window.__DSH_BOOT__ && window.__DSH_BOOT__.apiBase ? window.__DSH_BOOT__.apiBase : '';
      return base + '/lit-full-search/api/config';
    }

    function diagnoseUrl() {
      var base = window.__DSH_BOOT__ && window.__DSH_BOOT__.apiBase ? window.__DSH_BOOT__.apiBase : '';
      return base + '/lit-full-search/api/diagnose';
    }

    // ---- 槽位 1：侧栏图标（纯装饰字形；点击/选中由 sidebar PanelRow 负责）----
    function SettingsGlyph(props) {
      var size = (props && props.size) || 18;
      // feather 风格齿轮（stroke 图标：圆 + 齿），currentColor 跟随主题
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.8',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        React.createElement('circle', { cx: '12', cy: '12', r: '3' }),
        React.createElement('path', {
          d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
        })
      );
    }

    // ---- 设置页子组件 ----
    function PanelHeader(props) {
      return React.createElement(
        'div',
        { className: 'lfs-head' },
        React.createElement('div', { className: 'lfs-head-icon' }, React.createElement(SettingsGlyph, { size: 18 })),
        React.createElement(
          'div',
          null,
          React.createElement('div', { className: 'lfs-head-title' }, '全面搜索设置'),
          React.createElement(
            'div',
            { className: 'lfs-head-sub' },
            '配置写入 ',
            React.createElement('code', null, props.configFile || '~/.dsh/lit-full-search.config.json'),
            '，保存后立即生效；密钥只留在本地，接口不下发明文。'
          )
        )
      );
    }

    function Section(props) {
      return React.createElement(
        'section',
        { className: 'lfs-section' },
        React.createElement(
          'div',
          { className: 'lfs-section-head' },
          React.createElement('span', { className: 'lfs-section-title' }, props.title),
          props.note ? React.createElement('span', { className: 'lfs-section-note' }, props.note) : null
        ),
        React.createElement('div', { className: 'lfs-section-body' }, props.children)
      );
    }

    function IdentitySection(props) {
      return React.createElement(
        Section,
        { title: '身份标识', note: 'OpenAlex 礼貌池' },
        React.createElement(
          'div',
          { className: 'lfs-field' },
          React.createElement(
            'div',
            { className: 'lfs-label-row' },
            React.createElement('span', { className: 'lfs-label' }, 'Mailto 邮箱'),
            React.createElement('span', { className: 'lfs-badge env' }, 'LIT_SEARCH_MAILTO')
          ),
          React.createElement('input', {
            className: 'lfs-input',
            type: 'email',
            value: props.mailto,
            disabled: props.disabled,
            placeholder: 'you@example.com',
            onChange: function (e) { props.onMailto(e.target.value); },
          }),
          React.createElement('span', { className: 'lfs-hint' }, '可选。填写后 OpenAlex 请求进入礼貌池，限流更宽松；留空回落到环境变量。')
        )
      );
    }

    function SecretField(props) {
      var field = props.field;
      var cfg = props.cfg;
      var isSet = Boolean(cfg[field.key + 'Set']);
      var mask = cfg[field.key + 'Mask'] || '';
      var pending = props.value; // '' 未改动 | null 待清除 | string 待覆盖
      var cleared = pending === null;

      return React.createElement(
        'div',
        { className: 'lfs-field' },
        React.createElement(
          'div',
          { className: 'lfs-label-row' },
          React.createElement('span', { className: 'lfs-label' }, field.label),
          React.createElement(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            React.createElement('span', { className: 'lfs-badge ' + (isSet ? 'ok' : 'missing') },
              isSet ? '已设置' + (mask ? ' ' + mask : '') : '未设置'),
            isSet && !cleared
              ? React.createElement('button', {
                  type: 'button',
                  className: 'lfs-linkbtn danger',
                  disabled: props.disabled,
                  onClick: function () { props.onChange(null); },
                }, '清除')
              : null,
            cleared
              ? React.createElement('button', {
                  type: 'button',
                  className: 'lfs-linkbtn',
                  disabled: props.disabled,
                  onClick: function () { props.onChange(''); },
                }, '撤销清除')
              : null
          )
        ),
        React.createElement('input', {
          className: 'lfs-input',
          type: 'password',
          autoComplete: 'new-password',
          spellCheck: false,
          value: cleared ? '' : pending,
          disabled: props.disabled || cleared,
          placeholder: cleared ? '保存后删除此密钥' : (isSet ? '留空即保持不变，输入新值则覆盖' : '粘贴密钥'),
          onChange: function (e) { props.onChange(e.target.value); },
        }),
        React.createElement('span', { className: cleared || pending !== '' ? 'lfs-pending' : 'lfs-hint' },
          cleared ? '待保存：清除该密钥'
            : pending !== '' ? '待保存：覆盖为新值'
            : field.hint + ' 环境变量：' + field.env)
      );
    }

    function SecretsSection(props) {
      return React.createElement(
        Section,
        { title: '密钥', note: '留空＝保持不变' },
        SECRET_FIELDS.map(function (field) {
          return React.createElement(SecretField, {
            key: field.key,
            field: field,
            cfg: props.cfg,
            value: props.secrets[field.key],
            disabled: props.disabled,
            onChange: function (next) {
              props.onSecrets(function (prev) {
                var out = Object.assign({}, prev);
                out[field.key] = next;
                return out;
              });
            },
          });
        })
      );
    }

    function BudgetSection(props) {
      return React.createElement(
        Section,
        { title: '检索预算', note: '控制单次工具调用返回量，防上下文膨胀' },
        React.createElement(
          'div',
          { className: 'lfs-grid' },
          BUDGET_FIELDS.map(function (field) {
            return React.createElement(
              'div',
              { className: 'lfs-field', key: field.key },
              React.createElement(
                'div',
                { className: 'lfs-num-row' },
                React.createElement('span', { className: 'lfs-label' }, field.label),
                React.createElement('input', {
                  className: 'lfs-input num',
                  type: 'number',
                  min: field.min,
                  max: field.max,
                  step: field.step,
                  value: props.budget[field.key],
                  disabled: props.disabled,
                  onChange: function (e) { props.onChange(field.key, e.target.value); },
                  onBlur: function () { props.onBlur(field); },
                })
              ),
              React.createElement('span', { className: 'lfs-hint' }, field.hint)
            );
          })
        )
      );
    }

    function ActionBar(props) {
      return React.createElement(
        'div',
        { className: 'lfs-bar' },
        React.createElement('button', {
          type: 'button',
          className: 'lfs-btn lfs-btn-primary',
          disabled: props.saving || !props.dirty,
          onClick: props.onSave,
        }, props.saving ? '保存中…' : '保存'),
        React.createElement('button', {
          type: 'button',
          className: 'lfs-btn lfs-btn-ghost',
          disabled: props.saving || !props.dirty,
          onClick: props.onReset,
        }, '放弃更改'),
        props.msg
          ? React.createElement('span', { className: 'lfs-msg ' + props.msg.kind }, props.msg.text)
          : React.createElement('span', { className: 'lfs-hint' }, props.dirty ? '有未保存的更改' : '所有更改已保存')
      );
    }

    // ---- 服务诊断（对应 Host 路由 GET /lit-full-search/api/diagnose）----
    function DiagnosticsSection(_props) {
      var [running, setRunning] = React.useState(false);
      var [result, setResult] = React.useState(null); // { ranAt, checks:[{id,label,ok,detail}] }
      var [error, setError] = React.useState('');

      var run = function () {
        setRunning(true);
        setError('');
        fetch(diagnoseUrl(), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
          .then(function (res) {
            if (res.status === 200 && res.data && res.data.ok) setResult(res.data);
            else setError((res.data && res.data.error) || '诊断请求失败');
          })
          .catch(function (err) { setError('诊断请求失败: ' + (err.message || String(err))); })
          .finally(function () { setRunning(false); });
      };

      var children = [
        React.createElement('span', { className: 'lfs-hint', key: 'hint' },
          '检测 OpenAlex / Semantic Scholar / Zotero 本地 API 的可用性与密钥配置。'),
        React.createElement('div', { key: 'btn' },
          React.createElement('button', {
            type: 'button',
            className: 'lfs-btn lfs-btn-ghost',
            disabled: running,
            onClick: run,
          }, running ? '诊断中…' : '运行系统诊断')),
      ];
      if (error) {
        children.push(React.createElement('span', { className: 'lfs-msg err', key: 'err' }, error));
      }
      if (result && Array.isArray(result.checks)) {
        children.push(React.createElement('div', { className: 'lfs-diag-list', key: 'list' },
          result.checks.map(function (check) {
            return React.createElement('div', { className: 'lfs-diag-row', key: check.id },
              React.createElement('span', { className: 'lfs-badge ' + (check.ok ? 'ok' : 'missing') }, check.ok ? '✓' : '✗'),
              React.createElement('span', { className: 'lfs-diag-label' }, check.label),
              React.createElement('span', { className: 'lfs-diag-detail' }, check.detail || ''));
          })));
      }
      return React.createElement(Section, { title: '服务状态', note: '不发送密钥明文，仅本地检测' }, children);
    }

    // ---- 槽位 2：设置主面板（main keyed panel，与侧栏图标同 id）----
    function SettingsPanel(_props) {
      var [cfg, setCfg] = React.useState(null); // publicView 快照（不含明文密钥）
      var [configFile, setConfigFile] = React.useState('');
      var [loadErr, setLoadErr] = React.useState(null);
      var [loading, setLoading] = React.useState(true);
      var [mailto, setMailto] = React.useState('');
      var [budget, setBudget] = React.useState(DEFAULT_BUDGET);
      // 密钥编辑态：'' = 不改动（保留现值）；非空字符串 = 覆盖；null = 显式清除
      var [secrets, setSecrets] = React.useState({ openAlexApiKey: '', s2ApiKey: '', zoteroKey: '' });
      var [msg, setMsg] = React.useState(null);
      var [saving, setSaving] = React.useState(false);

      var adopt = React.useCallback(function (data) {
        setCfg(data.config);
        setConfigFile(data.configFile || '');
        setMailto(data.config.mailto || '');
        setBudget(Object.assign({}, DEFAULT_BUDGET, data.config.budget || {}));
        setSecrets({ openAlexApiKey: '', s2ApiKey: '', zoteroKey: '' });
      }, []);

      var load = React.useCallback(function () {
        setLoading(true);
        setLoadErr(null);
        return fetch(apiUrl())
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) { adopt(data); setMsg(null); }
            else setLoadErr((data && data.error) || '读取配置失败');
          })
          .catch(function (err) { setLoadErr('读取配置失败: ' + (err.message || String(err))); })
          .finally(function () { setLoading(false); });
      }, [adopt]);

      React.useEffect(function () { load(); }, [load]);

      // 预算输入：空串允许（显示为空），保存时回落默认；失焦夹到合法区间
      var setBudgetField = function (key, raw) {
        setBudget(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = raw;
          return next;
        });
      };

      var clampBudgetField = function (field) {
        setBudget(function (prev) {
          var next = Object.assign({}, prev);
          var n = Number(prev[field.key]);
          if (!Number.isFinite(n)) n = DEFAULT_BUDGET[field.key];
          n = Math.round(n);
          next[field.key] = Math.min(Math.max(n, field.min), field.max);
          return next;
        });
      };

      var dirty = React.useMemo(function () {
        if (!cfg) return false;
        if ((mailto || '') !== (cfg.mailto || '')) return true;
        if (secrets.openAlexApiKey !== '' || secrets.s2ApiKey !== '' || secrets.zoteroKey !== '') return true;
        for (var i = 0; i < BUDGET_FIELDS.length; i++) {
          var key = BUDGET_FIELDS[i].key;
          var current = cfg.budget && cfg.budget[key] !== undefined ? cfg.budget[key] : DEFAULT_BUDGET[key];
          if (Number(budget[key]) !== Number(current)) return true;
        }
        return false;
      }, [cfg, mailto, secrets, budget]);

      var save = function () {
        var patch = { mailto: mailto.trim(), budget: {} };
        BUDGET_FIELDS.forEach(function (field) {
          var n = Number(budget[field.key]);
          if (!Number.isFinite(n)) n = DEFAULT_BUDGET[field.key];
          patch.budget[field.key] = Math.min(Math.max(Math.round(n), field.min), field.max);
        });
        // 密钥：'' 不提交（服务端 undefined → 保留现值）；null → 清除；字符串 → 覆盖
        SECRET_FIELDS.forEach(function (field) {
          var pending = secrets[field.key];
          if (pending === null) patch[field.key] = '';
          else if (pending !== '') patch[field.key] = pending;
        });
        setSaving(true);
        setMsg(null);
        fetch(apiUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              adopt(data);
              setMsg({ kind: 'ok', text: '已保存，立即生效' });
            } else {
              setMsg({ kind: 'err', text: (data && data.error) || '保存失败' });
            }
          })
          .catch(function (err) { setMsg({ kind: 'err', text: '保存失败: ' + (err.message || String(err)) }); })
          .finally(function () { setSaving(false); });
      };

      var reset = function () {
        if (!cfg) return;
        setMailto(cfg.mailto || '');
        setBudget(Object.assign({}, DEFAULT_BUDGET, cfg.budget || {}));
        setSecrets({ openAlexApiKey: '', s2ApiKey: '', zoteroKey: '' });
        setMsg(null);
      };

      if (loading && !cfg) {
        return React.createElement('div', { className: 'lfs-page' },
          React.createElement('div', { className: 'lfs-shell' },
            React.createElement('div', { className: 'lfs-state' }, '正在读取配置…')));
      }

      if (!cfg) {
        return React.createElement('div', { className: 'lfs-page' },
          React.createElement('div', { className: 'lfs-shell' },
            React.createElement('div', { className: 'lfs-state' },
              React.createElement('div', { className: 'lfs-msg err' }, loadErr || '读取配置失败'),
              React.createElement('button', { type: 'button', className: 'lfs-linkbtn', style: { marginTop: '8px' }, onClick: load }, '重试'))));
      }

      return React.createElement(
        'div',
        { className: 'lfs-page' },
        React.createElement(
          'div',
          { className: 'lfs-shell' },
          React.createElement(PanelHeader, { configFile: configFile }),
          React.createElement(IdentitySection, { mailto: mailto, onMailto: setMailto, disabled: saving }),
          React.createElement(SecretsSection, { cfg: cfg, secrets: secrets, onSecrets: setSecrets, disabled: saving }),
          React.createElement(BudgetSection, { budget: budget, onChange: setBudgetField, onBlur: clampBudgetField, disabled: saving }),
          React.createElement(DiagnosticsSection, null),
          React.createElement(ActionBar, { saving: saving, dirty: dirty, msg: msg, onSave: save, onReset: reset })
        )
      );
    }

    // ---- apply：注册样式 + 槽位 ----
    var MAIN_PANEL_ID = 'lit-full-search-settings';

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) {
        console.warn('[dsh-lit-full-search] slots service unavailable; client idle');
        return;
      }
      var styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
      ctx.effect(function () { styleEl.remove(); }, 'dsh-lit-full-search: styles');

      // main（keyed）面板：设置页。panellist 点击 selectPanel 依赖此注册。
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: MAIN_PANEL_ID },
          function (props) { return React.createElement(SettingsPanel, { props: props }); }
        );
      });
      // 侧栏图标：紧贴定时任务（order 10）之下；条目点击/选中由 sidebar 负责
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: MAIN_PANEL_ID, order: 20, label: '全面搜索设置' },
          function (props) { return React.createElement(SettingsGlyph, { props: props }); }
        );
      });
    }

    exports.apply = apply;
    return module.exports;
  },
});