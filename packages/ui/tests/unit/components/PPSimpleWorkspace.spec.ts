import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PPSimpleWorkspace from '../../../src/components/app-layout/PPSimpleWorkspace.vue'
const provider = { id:'deepseek', name:'DeepSeek', requiresApiKey:true, defaultBaseURL:'https://api.deepseek.com', supportsDynamicModels:false }
const model = { id:'deepseek-chat', name:'DeepSeek Chat', providerId:'deepseek', capabilities:{supportsTools:false}, parameterDefinitions:[] }
function setup(existing = false) {
 const configs:any[] = existing ? [{id:'existing',name:'我的 DeepSeek',enabled:true,providerMeta:provider,modelMeta:model,connectionConfig:{apiKey:'private-test-key'}}] : []
 const services = { textAdapterRegistry:{getAllProviders:()=>[provider],getStaticModels:()=>[model]}, modelManager:{getAllModels:vi.fn(async()=>configs),addModel:vi.fn(async(_id,c)=>{configs.push(c)})}, promptService:{optimizePromptStream:vi.fn(async(_r,h)=>{h.onToken('清晰的提示词');await h.onComplete()})},historyManager:{createNewChain:vi.fn(async()=>({})),getRecords:vi.fn(async()=>[])} }
 const wrapper=mount(PPSimpleWorkspace,{global:{provide:{services:ref(services)}}})
 return {wrapper,services}
}
const button = (w:any,text:string)=>w.findAll('button').find((b:any)=>b.text().includes(text))!
beforeEach(()=>localStorage.clear())
describe('pp simplified workflow',()=>{
 it('onboards without sending a request and saves through the existing model manager',async()=>{
  const {wrapper:w,services:s}=setup();await flushPromises()
  await button(w,'下一步').trigger('click');await w.get('#pp-token').setValue('test-secret')
  expect(w.get('#pp-token').attributes('type')).toBe('password')
  await w.get('form').trigger('submit');await flushPromises()
  expect(s.modelManager.addModel).toHaveBeenCalledOnce();expect(s.promptService.optimizePromptStream).not.toHaveBeenCalled()
  expect(w.find('#pp-input').exists()).toBe(true);expect(localStorage.getItem('pp-simple-draft-v1')||'').not.toContain('test-secret');w.unmount()
 })
 it('rejects insecure endpoint without saving credentials',async()=>{
  const {wrapper:w,services:s}=setup();await flushPromises();await button(w,'下一步').trigger('click')
  await w.get('#pp-token').setValue('test-secret');await w.get('#pp-base').setValue('http://example.com');await w.get('form').trigger('submit');await flushPromises()
  expect(s.modelManager.addModel).not.toHaveBeenCalled();expect(w.get('[role="alert"]').text()).toContain('https');w.unmount()
 })
 it('reuses existing credentials without exposing or overwriting them and saves completed history',async()=>{
  const {wrapper:w,services:s}=setup(true);await flushPromises();expect(w.html()).not.toContain('private-test-key')
  await button(w,'使用已有配置').trigger('click');await w.get('#pp-input').setValue('帮我写文章');await button(w,'帮我优化').trigger('click');await flushPromises()
  expect(s.modelManager.addModel).not.toHaveBeenCalled();expect(s.historyManager.createNewChain).toHaveBeenCalledWith(expect.objectContaining({originalPrompt:'帮我写文章',optimizedPrompt:'清晰的提示词',modelKey:'existing'}))
  expect(JSON.parse(localStorage.getItem('pp-simple-draft-v1')!).result).toBe('清晰的提示词');w.unmount()
 })
 it('keeps input and reports provider failure without leaking credentials or recording success',async()=>{
  const {wrapper:w,services:s}=setup(true);s.promptService.optimizePromptStream.mockImplementation(async(_r,h)=>h.onError(new Error('private-test-key')))
  await flushPromises();await button(w,'使用已有配置').trigger('click');await w.get('#pp-input').setValue('保留我的输入');await button(w,'帮我优化').trigger('click');await flushPromises()
  expect(s.historyManager.createNewChain).not.toHaveBeenCalled();expect(w.get('[role="alert"]').text()).not.toContain('private-test-key');expect((w.get('#pp-input').element as HTMLTextAreaElement).value).toBe('保留我的输入');w.unmount()
 })
})
