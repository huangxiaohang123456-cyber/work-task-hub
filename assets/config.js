/* 工作任务台 · 配置
 * 当前为「本地版」：数据保存在你本机浏览器(localStorage)，无需数据库、无需登录，打开即用。
 * 后续若要开启「团队共享 + 云端同步」，再切回 Supabase 模式（届时恢复 network 层即可）。
 */
window.APP_CONFIG = {
  STORAGE_MODE: 'local',   // 'local' = 本机存储；'supabase' = 云端（待接入）
  APP_NAME: '工作任务台'
};
