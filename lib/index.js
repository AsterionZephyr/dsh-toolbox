/**
 * dsh-toolbox —— 宿主半边。
 *
 * 这个插件的工作全在浏览器侧（lib/client.js）：它拿到 `ctx.slots` 之后
 *   1) 给 SlotRegistry.entries('settings.section') 套一层「折叠集合」过滤器，
 *      于是被收纳的设置页不再出现在设置侧栏导航里；
 *   2) 注册自己的 `settings.section`（id: toolbox），并在该条目下声明
 *      `toolbox.page` 子槽位；展开某个被收纳的页时，把那个页原本的组件
 *      连同它的 locale / inject / store 席位一起重新注册进 `toolbox.page`，
 *      由槽位框架照常组装 props —— 没有伪造 props，也不绕过声明授权。
 *
 * 宿主这半边不需要配置、不需要服务、不碰文件系统；留着一个空 apply 是为了
 * 让 Loader 有一个真实条目可挂（dsh-client-modules 只扫描已启用的 Loader
 * 条目来发现 `dsh.client` 声明）。
 *
 * @module dsh-toolbox
 */

export const name = 'toolbox'

// 不注入任何宿主服务：少一个 inject 就少一条「服务缺席则不激活」的路径。
export const inject = []

export function apply() {
  // 有意留空：所有行为在客户端。
}
