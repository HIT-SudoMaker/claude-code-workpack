import type { MessageText } from './errors.js';

export const WARNING_MESSAGES: Readonly<Record<string, MessageText>> = {
  'program-identity-unchecked': { brief: '身份待确认', detail: '程序文件已找到；操作前确认身份' },
  'program-inspection-warning': { brief: '检查不完整', detail: '检查其他安装不完整' },
  'inspection-incomplete': { brief: '检查不完整', detail: '检查不完整' },
  'new-session-required': { brief: '稍后生效', detail: '新会话或重新加载后生效' },
};
