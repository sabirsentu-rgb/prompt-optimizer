<script setup lang="ts">
import { computed, inject, onMounted, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { TextModelConfig, TextProvider, PromptRecord } from '@prompt-optimizer/core'
import type { AppServices } from '../../types/services'
import logo from '../../assets/logo.png'

const emit = defineEmits<{ advanced: []; backup: []; favorites: []; busy: [value: boolean] }>()
const services = inject<Ref<AppServices | null>>('services')!
const api = () => services.value!
const providers = ref<TextProvider[]>([])
const configs = ref<TextModelConfig[]>([])
const selected = ref('')
const providerId = ref('deepseek')
const modelId = ref('')
const token = ref('')
const baseURL = ref('')
const reveal = ref(false)
const stage = ref<'provider' | 'token' | 'workspace'>('provider')
const busy = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const prompt = ref('')
const result = ref('')
const history = ref<PromptRecord[]>([])
const showHistory = ref(false)
const query = ref('')
let controller: AbortController | undefined
const provider = computed(() => providers.value.find(p => p.id === providerId.value))
const models = computed(() => api().textAdapterRegistry?.getStaticModels(providerId.value) || [])
const current = computed(() => configs.value.find(c => c.id === selected.value))
const readyConfigs = computed(() => configs.value.filter(c => c.enabled && (c.connectionConfig.apiKey || !c.providerMeta.requiresApiKey)))
const filteredHistory = computed(() => history.value.filter(h => (h.originalPrompt + h.optimizedPrompt).toLowerCase().includes(query.value.toLowerCase())))
const draftKey = 'pp-simple-draft-v1'
const choiceKey = 'pp-simple-model-v1'
function persist() {
  try { localStorage.setItem(draftKey, JSON.stringify({ prompt: prompt.value, result: result.value })) }
  catch { notice.value = '浏览器存储空间不足，请复制结果留存。' }
}
watch([prompt, result], persist)
watch(busy, value => emit('busy', value), { flush: 'sync' })
watch(providerId, () => { modelId.value = models.value[0]?.id || ''; baseURL.value = provider.value?.defaultBaseURL || ''; token.value = ''; reveal.value = false })
watch(selected, value => { try { localStorage.setItem(choiceKey, value) } catch { /* Selection is usable for this session. */ } })
onMounted(async () => {
  try {
    providers.value = (api().textAdapterRegistry?.getAllProviders() || []).filter(p => ['deepseek','openai','gemini','zhipu','siliconflow','dashscope'].includes(p.id))
    if (!providers.value.some(p => p.id === providerId.value)) providerId.value = providers.value[0]?.id || ''
    modelId.value = models.value[0]?.id || ''
    baseURL.value = provider.value?.defaultBaseURL || ''
    configs.value = await api().modelManager.getAllModels()
    const saved = localStorage.getItem(choiceKey)
    selected.value = readyConfigs.value.find(c => c.id === saved)?.id || readyConfigs.value[0]?.id || ''
    if (saved && current.value) stage.value = 'workspace'
    const draft = JSON.parse(localStorage.getItem(draftKey) || '{}')
    if (typeof draft.prompt === 'string') prompt.value = draft.prompt
    if (typeof draft.result === 'string') result.value = draft.result
  } catch { error.value = '读取配置失败，请刷新重试，或通过高级模式检查模型设置。' }
})
onBeforeUnmount(() => { controller?.abort(); emit('busy', false) })
function continueExisting() { if (current.value) { stage.value = 'workspace'; error.value = ''; try { localStorage.setItem(choiceKey, selected.value) } catch {} } }
function next() { error.value = ''; stage.value = 'token' }
async function saveModel() {
  error.value = ''; notice.value = ''
  const p = provider.value
  if (!p || !modelId.value.trim() || (p.requiresApiKey && !token.value.trim())) { error.value = '请填写模型名称和 API Token。'; return }
  try {
    const url = new URL(baseURL.value)
    if (url.protocol !== 'https:') { error.value = '请使用以 https:// 开头的 API 地址。'; return }
  } catch { error.value = '请输入有效的 API 地址。'; return }
  saving.value = true
  try {
    const meta = models.value.find(m => m.id === modelId.value.trim()) || { id: modelId.value.trim(), name: modelId.value.trim(), providerId: p.id, capabilities: { supportsTools: false }, parameterDefinitions: [] }
    const id = `pp_${crypto.randomUUID()}`
    await api().modelManager.addModel(id, { id, name: `${p.name} · ${meta.name}`, enabled: true, activationState: { userConfigured: true }, providerId: p.id, modelId: meta.id, providerMeta: p, modelMeta: meta, connectionConfig: { apiKey: token.value.trim(), baseURL: baseURL.value.trim() }, paramOverrides: {} })
    configs.value = await api().modelManager.getAllModels()
    selected.value = id; token.value = ''; reveal.value = false; stage.value = 'workspace'
    notice.value = '配置已保存。点击「帮我优化」时才会调用模型。'
  } catch { error.value = '配置未能保存，请重试。' }
  finally { saving.value = false }
}
async function optimize() {
  if (busy.value || !prompt.value.trim() || !current.value) return
  const input = prompt.value.trim(), modelKey = selected.value
  busy.value = true; result.value = ''; error.value = ''; notice.value = ''
  controller = new AbortController()
  let streamError: Error | undefined
  try {
    await api().promptService.optimizePromptStream({ optimizationMode: 'system', targetPrompt: input, modelKey }, {
      signal: controller.signal,
      onToken: chunk => { result.value += chunk },
      onComplete: () => {},
      onError: e => { streamError = e },
    })
    if (controller.signal.aborted) { notice.value = '已停止，已生成的内容保留在右侧。'; return }
    if (streamError) throw streamError
    if (!result.value.trim()) throw new Error('empty')
    try {
      await api().historyManager.createNewChain({ id: crypto.randomUUID(), originalPrompt: input, optimizedPrompt: result.value, type: 'optimize', timestamp: Date.now(), modelKey, templateId: 'general-optimize', metadata: { optimizationMode: 'system' } })
      notice.value = '优化完成，已保存到历史记录。'
    } catch { notice.value = '优化完成，但历史保存失败，请先复制结果。' }
  } catch {
    if (controller.signal.aborted) notice.value = '已停止，已生成的内容保留在右侧。'
    else error.value = '暂时未能完成优化。请检查 Token、账户余额和网络；部分模型商可能限制网页直接调用。你可以更换模型或在高级模式检查连接。'
  } finally { busy.value = false; controller = undefined; persist() }
}
async function copy() {
  try { await navigator.clipboard.writeText(result.value); notice.value = '已复制，去和 AI 聊聊吧。' }
  catch { notice.value = '无法自动复制，请选中结果手动复制。' }
}
async function openHistory() {
  try { history.value = (await api().historyManager.getRecords()).sort((a,b) => b.timestamp - a.timestamp); showHistory.value = true }
  catch { error.value = '历史记录读取失败，请稍后重试。' }
}
function reuse(record: PromptRecord) { prompt.value = record.originalPrompt; result.value = record.optimizedPrompt; showHistory.value = false }
</script>

<template>
  <div class="pp-app">
    <header class="pp-header">
      <a class="pp-brand" href="#/basic/system" @click.prevent="stage = selected ? 'workspace' : 'provider'"><img :src="logo" alt="pp 标志" /><span>pp<span class="pp-brand-light">提示词优化</span></span></a>
      <nav aria-label="主要导航"><button :disabled="busy" @click="openHistory">历史记录</button><button :disabled="busy" @click="emit('favorites')">我的收藏</button><button :disabled="busy" @click="emit('backup')">备份</button><button :disabled="busy" class="pp-quiet" @click="emit('advanced')">高级模式 ↗</button></nav>
    </header>
    <main>
      <template v-if="stage !== 'workspace'">
        <section class="pp-welcome"><span class="pp-eyebrow">让好想法，被 AI 听懂</span><h1>你好，我是 pp<span class="pp-spark">✦</span><br/>让提示词，简单一点。</h1><p>连接你喜欢的模型，把一句想法变成清晰好用的提示词。</p></section>
        <section class="pp-setup">
          <aside class="pp-mascot"><img :src="logo" alt="紫色和蓝色的 pp 小伙伴" /><h2>你的灵感，我来整理。</h2><p>少一点设置，多一点创造。</p><div class="pp-steps"><span :class="{active:stage === 'provider'}">01 选模型商</span><span :class="{active:stage === 'token'}">02 填 Token</span><span>03 开始优化</span></div></aside>
          <div class="pp-setup-form">
            <template v-if="stage === 'provider'"><span class="pp-eyebrow">第一步 / 共两步</span><h2>先选一位 AI 搭档</h2><p class="pp-muted">选择你已有 API 账户的模型商。</p><div class="pp-provider-grid"><button v-for="p in providers" :key="p.id" class="pp-provider" :class="{selected:providerId === p.id}" :aria-pressed="providerId === p.id" @click="providerId = p.id"><span class="pp-provider-icon">{{ p.name.slice(0,1) }}</span><span>{{ p.name }}</span><span v-if="providerId === p.id" class="pp-check">✓</span></button></div><button class="pp-primary pp-wide" :disabled="!provider" @click="next">下一步，填写 Token <span>→</span></button>
              <div v-if="readyConfigs.length" class="pp-existing"><label for="pp-existing">发现已有配置，可以直接使用</label><select id="pp-existing" v-model="selected"><option v-for="c in readyConfigs" :key="c.id" :value="c.id">{{ c.name }}</option></select><button class="pp-link" @click="continueExisting">使用已有配置 →</button></div>
            </template>
            <form v-else @submit.prevent="saveModel"><button type="button" class="pp-link" @click="stage = 'provider'; token = ''">← 重新选模型商</button><h2>连接 {{ provider?.name }}</h2><p class="pp-muted">Token 就是模型商提供的 API Key，不是登录密码。</p><label for="pp-token">API Token</label><div class="pp-token-field"><input id="pp-token" v-model="token" :type="reveal ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="粘贴你的 API Key" :required="provider?.requiresApiKey" /><button type="button" @click="reveal = !reveal">{{ reveal ? '隐藏' : '显示' }}</button></div><a v-if="provider?.apiKeyUrl" class="pp-link" :href="provider.apiKeyUrl" target="_blank" rel="noopener noreferrer">去 {{ provider.name }} 获取 API Key ↗</a><label for="pp-model">使用哪个模型</label><input id="pp-model" v-model="modelId" list="pp-models" required placeholder="选择或输入模型 ID" /><datalist id="pp-models"><option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option></datalist><details class="pp-details" :open="providerId === 'custom'"><summary>自定义 API 地址（可选）</summary><label for="pp-base">API 地址</label><input id="pp-base" v-model="baseURL" type="url" required /></details><p class="pp-privacy">Token 仅保存在此浏览器中，调用时发送给上方 API 地址。模型费用由对应服务商收取。</p><button class="pp-primary pp-wide" :disabled="saving" type="submit">{{ saving ? '正在保存…' : '保存，开始使用 →' }}</button></form>
          </div>
        </section>
      </template>
      <template v-else>
        <section class="pp-workspace-intro"><div><span class="pp-eyebrow">想法不必完美，先写下来</span><h1>把想法交给 pp<span class="pp-spark">✦</span></h1><p>说清楚你想做什么，剩下的交给你的 AI 搭档。</p></div><img :src="logo" alt="pp 小伙伴" /></section>
        <div class="pp-model-bar"><label for="pp-active-model">当前搭档</label><select id="pp-active-model" v-model="selected" :disabled="busy"><option v-for="c in readyConfigs" :key="c.id" :value="c.id">{{ c.name }}</option></select><button :disabled="busy" @click="stage = 'provider'; error = ''; notice = ''">＋ 连接模型</button></div>
        <div class="pp-editors"><section class="pp-editor-card"><div class="pp-card-title"><h2><span>01</span> 你的想法</h2><span class="pp-muted">自然表达就好</span></div><label for="pp-input" class="pp-sr-only">需要优化的提示词</label><textarea id="pp-input" v-model="prompt" :disabled="busy" placeholder="比如：帮我写一篇小红书文案，介绍一家安静的咖啡店，语气轻松一点……" /><div v-if="!prompt" class="pp-examples"><span>没有头绪？试试</span><button @click="prompt = '帮我写一篇小红书文案，介绍一家适合独处的咖啡店，语气轻松自然。'">✎ 内容创作</button><button @click="prompt = '帮我制定一个适合零基础的英语学习计划，每天可以投入半小时。'">☀ 学习计划</button><button @click="prompt = '你是一位耐心的编程老师，请用简单语言和例子讲解我提供的代码。'">⌘ 编程助手</button></div><div class="pp-editor-bottom"><span class="pp-muted">{{ prompt.length }} 字</span><button v-if="busy" class="pp-secondary" @click="controller?.abort()">停止生成</button><button v-else class="pp-primary" :disabled="!prompt.trim() || !current" @click="optimize">✦ 帮我优化</button></div></section>
        <section class="pp-editor-card pp-result"><div class="pp-card-title"><h2><span>02</span> 更好的提示词</h2><button class="pp-secondary" :disabled="!result || busy" @click="copy">复制结果 ↗</button></div><template v-if="result || busy"><label for="pp-output" class="pp-sr-only">优化结果</label><textarea id="pp-output" v-model="result" :readonly="busy" :placeholder="busy ? 'pp 正在整理你的想法…' : ''" /><div class="pp-editor-bottom"><span class="pp-muted">{{ busy ? '正在生成，请稍等…' : '可以直接复制，也可以继续修改' }}</span></div></template><div v-else class="pp-empty"><span>✦</span><h3>好提示词，从一个想法开始</h3><p>在左边写下需求，点击「帮我优化」。<br/>清晰、完整的提示词就会出现在这里。</p></div></section></div>
      </template>
      <p v-if="error" class="pp-message pp-error" role="alert">{{ error }}</p><p v-if="notice" class="pp-message" role="status">{{ notice }}</p>
    </main>
    <footer><span>pp提示词优化 · 给灵感一点魔法</span><span>基于 <a href="https://github.com/linshenkx/prompt-optimizer" target="_blank" rel="noopener noreferrer">Prompt Optimizer</a> · <a href="https://github.com/sabirsentu-rgb/prompt-optimizer/tree/pp-simple-ui" target="_blank" rel="noopener noreferrer">开源代码 / AGPL-3.0</a></span></footer>
    <div v-if="showHistory" class="pp-overlay" @click.self="showHistory = false" @keydown.esc="showHistory = false"><section role="dialog" aria-modal="true" aria-labelledby="pp-history-title" class="pp-history"><div class="pp-card-title"><h2 id="pp-history-title">我的历史 <small>{{ history.length }} 条</small></h2><button @click="showHistory = false">关闭 ✕</button></div><input v-model="query" aria-label="搜索历史" placeholder="搜索以前的想法…" /><p v-if="!filteredHistory.length" class="pp-muted">{{ query ? '没有找到匹配的历史。' : '还没有历史，完成一次优化后会自动保存在这里。' }}</p><button v-for="record in filteredHistory" :key="record.id" class="pp-history-item" @click="reuse(record)"><strong>{{ record.originalPrompt.slice(0,90) }}</strong><span>{{ new Date(record.timestamp).toLocaleString('zh-CN') }} · 点击打开</span></button></section></div>
  </div>
</template>

<style scoped>
.pp-app{--ink:#302341;--muted:#81758e;--purple:#8951cf;--border:#e9e2f0;position:fixed;inset:0;min-height:100dvh;background:radial-gradient(ellipse at 15% 18%,#f1e8ff 0,transparent 45%),radial-gradient(ellipse at 95% 45%,#eaf0ff 0,transparent 40%),#fcfaff;color:var(--ink);font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;overflow:auto}
.pp-app *{box-sizing:border-box}.pp-app button,.pp-app input,.pp-app select,.pp-app textarea{font:inherit}.pp-app button{cursor:pointer;border:0;background:none;color:inherit;transition:background .16s,transform .16s}.pp-app button:disabled{opacity:.45;cursor:not-allowed}.pp-app button:focus-visible,.pp-app a:focus-visible,.pp-app summary:focus-visible{outline:3px solid #ab85e5;outline-offset:4px}.pp-app a{color:inherit}.pp-header{max-width:1280px;margin:auto;padding:23px 40px;display:flex;justify-content:space-between;align-items:center;gap:24px;border-bottom:1px solid var(--border)}.pp-brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:850;font-size:25px;letter-spacing:-1px}.pp-brand img{width:52px;height:52px;object-fit:contain;border-radius:16px}.pp-brand-light{font-size:19px;margin-left:5px;letter-spacing:0}.pp-header nav{display:flex;gap:8px;flex-wrap:wrap}.pp-header nav button{padding:9px 13px;border-radius:10px}.pp-header nav button:hover{background:#ede4f6}.pp-quiet{color:var(--muted)!important}.pp-app main{max-width:1160px;margin:auto;padding:40px 32px 20px}.pp-welcome{text-align:center;margin:5px 0 30px}.pp-eyebrow{font-size:12px;font-weight:700;letter-spacing:2px;color:#9464bd}.pp-app h1{font-size:clamp(30px,4vw,46px);letter-spacing:-1.8px;line-height:1.3;margin:12px 0 14px;font-weight:800}.pp-app h2{font-size:23px;font-weight:700;margin:10px 0}.pp-app p{color:var(--muted)}.pp-spark{color:#ba8be9;font-size:32px;margin-left:12px}.pp-setup{display:grid;grid-template-columns:0.9fr 1.1fr;background:#ffffffd9;border:1px solid #fff;border-radius:28px;box-shadow:0 20px 65px #7049a00d;overflow:hidden;max-width:960px;margin:auto}.pp-mascot{background:linear-gradient(145deg,#eee1fc,#e7edff);padding:38px 30px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.pp-mascot>img{width:230px;max-width:90%;border-radius:40px;mix-blend-mode:multiply}.pp-mascot h2{font-size:22px;margin:22px 0 0}.pp-mascot p{margin:7px 0 26px}.pp-steps{display:flex;gap:12px;font-size:11px;color:#8e80a0;flex-wrap:wrap;justify-content:center}.pp-steps .active{color:#7543ad;font-weight:700}.pp-setup-form{padding:36px 38px}.pp-muted{color:var(--muted);font-size:12px}.pp-provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:24px 0}.pp-app .pp-provider{position:relative;display:flex;align-items:center;gap:10px;text-align:left;padding:15px 12px;border:1px solid var(--border);border-radius:14px;font-weight:600;background:white}.pp-app .pp-provider.selected{border-color:#aa79df;background:#f7f0ff;box-shadow:0 0 0 1px #aa79df}.pp-provider-icon{background:#ede8f8;border-radius:10px;width:30px;height:30px;display:grid;place-items:center;color:#8650c4}.pp-check{margin-left:auto;color:#8951cf}.pp-app .pp-primary{background:linear-gradient(100deg,#9052d2,#7976df);color:#fff;border-radius:12px;padding:13px 23px;font-weight:650;box-shadow:0 5px 15px #8b5acc20}.pp-app .pp-primary:hover:not(:disabled){transform:translateY(-1px);background:#8148be}.pp-wide{width:100%;display:flex;justify-content:space-between}.pp-existing{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}.pp-app label{display:block;font-size:12px;font-weight:600;margin:16px 0 7px}.pp-app input,.pp-app select{width:100%;border:1px solid var(--border);border-radius:10px;background:white;color:var(--ink);padding:11px 12px;outline:none}.pp-app input:focus,.pp-app select:focus,.pp-app textarea:focus{border-color:#a375d4;box-shadow:0 0 0 3px #b18bd51a}.pp-app .pp-link{display:inline-block;color:#8850bc;font-size:12px;margin:10px 0;text-decoration:none}.pp-token-field{display:flex;align-items:center;border:1px solid var(--border);border-radius:10px;background:white}.pp-token-field input{border:0;min-width:0}.pp-token-field button{flex-shrink:0;padding:10px;font-size:12px}.pp-details{margin-top:15px;color:var(--muted);font-size:12px}.pp-details summary{cursor:pointer}.pp-privacy{font-size:11px;line-height:1.8;margin:20px 0}.pp-workspace-intro{display:flex;justify-content:space-between;align-items:center;gap:24px;margin:5px 0 24px}.pp-workspace-intro img{width:130px;border-radius:26px;mix-blend-mode:multiply}.pp-workspace-intro h1{font-size:38px}.pp-model-bar{display:flex;align-items:center;gap:14px;margin:0 0 18px}.pp-model-bar label{margin:0;white-space:nowrap;color:var(--muted)}.pp-model-bar select{max-width:290px;background:#ffffffa6}.pp-model-bar button{font-size:12px;color:#8650c4}.pp-editors{display:grid;grid-template-columns:1fr 1fr;gap:22px}.pp-editor-card{display:flex;flex-direction:column;background:#fff;border:1px solid var(--border);border-radius:22px;overflow:hidden;min-height:420px;box-shadow:0 10px 30px #5d308007}.pp-card-title{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f1edf5;gap:12px}.pp-card-title h2{font-size:16px;margin:0}.pp-card-title h2>span{color:#aa85cb;font-size:12px;margin-right:10px}.pp-app textarea{resize:vertical;border:1px solid transparent;outline:none;flex:1;min-height:250px;background:transparent;color:var(--ink);padding:22px;font-size:14px;line-height:1.9;width:100%}.pp-app textarea::placeholder{color:#aa9db5}.pp-editor-bottom{padding:16px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}.pp-examples{padding:0 22px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--muted)}.pp-examples button{padding:6px 9px;border-radius:7px;background:#f6f2fb}.pp-result{background:linear-gradient(140deg,#fff,#fbf9ff)}.pp-app .pp-secondary{border:1px solid var(--border);border-radius:9px;font-size:12px;padding:7px 12px;background:white}.pp-empty{margin:auto;padding:40px 22px;text-align:center}.pp-empty>span{display:inline-grid;place-items:center;width:58px;height:58px;background:#eee6fb;border-radius:20px;color:#ad7cdd;font-size:30px}.pp-empty h3{font-size:15px;font-weight:500;margin-top:20px}.pp-empty p{font-size:12px;line-height:1.9}.pp-app .pp-message{padding:12px 18px;border-radius:12px;background:#f0e8fa;color:#6e478b;font-size:13px}.pp-app .pp-error{background:#fff0f2;color:#a13750}.pp-app footer{max-width:1160px;padding:24px 32px;margin:auto;display:flex;justify-content:space-between;gap:12px;color:#9c8faa;font-size:11px}.pp-app footer a{text-decoration:none}.pp-overlay{position:fixed;inset:0;background:#29183b55;backdrop-filter:blur(5px);display:grid;place-items:center;padding:24px;z-index:2000}.pp-history{max-width:700px;width:100%;max-height:85dvh;overflow:auto;background:#fff;border-radius:22px;padding:8px 24px 24px}.pp-history .pp-card-title{padding:16px 0}.pp-history small{font-weight:400;color:var(--muted);margin-left:10px}.pp-history input{margin:16px 0}.pp-app .pp-history-item{display:block;width:100%;padding:16px 0;text-align:left;border-bottom:1px solid var(--border)}.pp-history-item strong{display:block;font-weight:500}.pp-history-item span{display:block;font-size:11px;color:var(--muted);margin-top:6px}.pp-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:760px){.pp-header{padding:16px 20px;align-items:flex-start;flex-direction:column;gap:12px}.pp-header nav{gap:0;justify-content:space-between;width:100%}.pp-header nav button{font-size:12px;padding:6px 8px}.pp-app main{padding:28px 18px 12px}.pp-setup{grid-template-columns:1fr}.pp-mascot{padding:18px}.pp-mascot>img{width:100px}.pp-mascot h2,.pp-mascot p{display:none}.pp-steps{margin-top:14px}.pp-setup-form{padding:26px 22px}.pp-workspace-intro h1{font-size:28px;letter-spacing:-1px}.pp-workspace-intro img{width:75px}.pp-workspace-intro p{font-size:12px}.pp-editors{grid-template-columns:1fr}.pp-editor-card{min-height:330px}.pp-model-bar{flex-wrap:wrap;gap:9px}.pp-model-bar select{flex:1;min-width:0}.pp-app footer{flex-direction:column;padding:20px}.pp-welcome h1{font-size:33px}.pp-welcome p{font-size:12px}.pp-app textarea{min-height:200px}.pp-overlay{padding:14px}}
</style>
