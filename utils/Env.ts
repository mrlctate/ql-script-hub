/**
 * AutoPilot - 青龙面板通用环境类
 * @author Astral
 * @version 1.1.0
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import moment from 'moment';
import * as fs from 'fs';
import * as path from 'path';

export interface EnvOptions {
  sep?: string[];
  // 0: 不通知, 1: 仅错误通知, 2: 总是通知
  notifyType?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Env {
  public index = 0;
  public req: AxiosInstance;
  public hasError = false;
  private msgs: string[] = [];
  private logs: string[] = [];
  private startTime: number;
  public options: Required<EnvOptions>;

  constructor(
    public name: string,
    options: EnvOptions = {}
  ) {
    this.startTime = Date.now();
    this.options = {
      sep: options.sep || ['&', '\n', '@'],
      notifyType: options.notifyType ?? (Number(process.env.NOTIFY_TYPE) || 1),
      logLevel: options.logLevel || (process.env.LOG_LEVEL as LogLevel) || 'info',
    };

    this.req = axios.create({
      timeout: Number(process.env.REQUEST_TIMEOUT) * 1000 || 30000,
      headers: {
        'User-Agent': process.env.USER_AGENT || 'AutoPilot/1.1',
      },
    });

    this.initProxy();
    this.log(`🚀 开始执行: ${this.name}`, 'info');
  }

  private initProxy(): void {
    if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      this.req.defaults.proxy = {
        host: process.env.HTTP_PROXY_HOST || '127.0.0.1',
        port: Number(process.env.HTTP_PROXY_PORT) || 7890,
      };
    }
  }

  /**
   * 初始化脚本入口
   * @param TaskClass 任务类，需实现 start 方法
   * @param envName 环境变量名
   */
  async init<T extends { start: () => Promise<void> }>(
    TaskClass: new (config: string, index: number) => T,
    envName: string
  ): Promise<void> {
    try {
      const envValue = process.env[envName];

      if (!envValue) {
        this.log(`未找到环境变量: ${envName}`, 'warn');
        await this.done();
        return;
      }

      const users = this.parse(envValue, this.options.sep);
      const userKeys = Object.keys(users);

      if (userKeys.length === 0) {
        this.log(`环境变量 ${envName} 格式解析后为空`, 'warn');
        await this.done();
        return;
      }

      this.log(`发现 ${userKeys.length} 个账号`, 'info');

      for (const idxStr of userKeys) {
        this.index = Number(idxStr);
        const task = new TaskClass(users[this.index], this.index);
        await task.start().catch((err) => {
          this.log(`账号 [${this.index + 1}] 执行异常: ${err.message}`, 'error');
        });
      }

      await this.done();
    } catch (error) {
      this.log(`程序运行崩溃: ${(error as Error).message}`, 'error');
      await this.done();
    }
  }

  private parse(envValue: string, seps: string[]): Record<number, string> {
    const sep = seps.find((s) => envValue.includes(s)) || seps[0];
    return envValue
      .split(sep)
      .map((v) => v.trim())
      .filter(Boolean)
      .reduce((acc, curr, idx) => ({ ...acc, [idx]: curr }), {});
  }

  log(msg: string, level: LogLevel = 'info'): void {
    const timestamp = moment().format('HH:mm:ss');
    const logMsg = `[${timestamp}][${level.toUpperCase()}] ${msg}`;

    if (this.shouldLog(level)) {
      const colors = {
        debug: '\x1b[36m', // Cyan
        info: '\x1b[32m', // Green
        warn: '\x1b[33m', // Yellow
        error: '\x1b[31m', // Red
      };
      console.log(`${colors[level]}${logMsg}\x1b[0m`);
    }

    this.logs.push(logMsg);
    if (level === 'error') this.hasError = true;
    if (level !== 'debug') this.msgs.push(msg);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.options.logLevel);
  }

  async request<T = any>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response: AxiosResponse<T> = await this.req.request(config);
      return response.data;
    } catch (error) {
      const err = error as AxiosError;
      const msg = err.response
        ? `HTTP ${err.response.status} - ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log(`网络请求失败: ${msg}`, 'error');
      throw error;
    }
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'GET', url });
  }
  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig) {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  /**
   * 持久化存储
   */
  getStorage(name: string) {
    const storageDir = path.join(__dirname, '../storage');
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    const storageFile = path.join(storageDir, `${name}.json`);

    const read = (): Record<string, any> => {
      if (!fs.existsSync(storageFile)) return {};
      try {
        return JSON.parse(fs.readFileSync(storageFile, 'utf-8'));
      } catch {
        return {};
      }
    };

    return {
      getItem: async (key: string): Promise<any> => read()[key] || null,
      setItem: async (key: string, value: any): Promise<void> => {
        const data = read();
        data[key] = value;
        fs.writeFileSync(storageFile, JSON.stringify(data, null, 2));
      },
      removeItem: async (key: string): Promise<void> => {
        const data = read();
        delete data[key];
        fs.writeFileSync(storageFile, JSON.stringify(data, null, 2));
      },
    };
  }

  async done(): Promise<void> {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
    this.log(`🏁 任务结束: ${this.name} (耗时 ${duration}s)`, 'info');

    if (this.shouldNotify()) await this.sendNotify();

    console.log(`\n${'='.repeat(40)}`);
    console.log(`执行统计: ${this.name}`);
    console.log(`状态: ${this.hasError ? '❌ 存在异常' : '✅ 顺利完成'}`);
    console.log(`耗时: ${duration} 秒`);
    console.log(`${'='.repeat(40)}\n`);
  }

  private shouldNotify(): boolean {
    const { notifyType } = this.options;
    return notifyType === 2 || (notifyType === 1 && this.hasError);
  }

  private async sendNotify(): Promise<void> {
    const notifyPath = path.join(__dirname, 'sendNotify.js');
    if (!fs.existsSync(notifyPath)) return;

    try {
      const sendNotify = require(notifyPath);
      const title = `[${this.hasError ? '异常' : '成功'}] ${this.name}`;
      const content = this.msgs.join('\n');
      const func = sendNotify.sendNotify || sendNotify;
      if (typeof func === 'function') await func(title, content);
    } catch (error) {
      this.log(`推送通知失败: ${(error as Error).message}`, 'error');
    }
  }

  debug(msg: string): void {
    this.log(msg, 'debug');
  }
}

export default Env;