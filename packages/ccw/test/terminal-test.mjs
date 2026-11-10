import { runTerminal as run } from '../dist/terminal.js';

/** 既有菜单场景的界面夹具：默认无旧任务，并确认新增的安装预览。恢复场景直接调用真实入口。 */
export const runTerminal = (ccw, terminal, signal) =>
  run(
    { recovery: async () => undefined, abandon: async () => {}, ...ccw },
    {
      ...terminal,
      choose: (title, choices, ...rest) =>
        typeof title === 'string' && title.startsWith('变更预览') && choices[0] === '确认安装'
          ? Promise.resolve(terminal.confirmInstallPreview?.(title, choices) ?? 0)
          : terminal.choose(title, choices, ...rest),
    },
    signal,
  );
