import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const FILE_ENCODING = 'utf8';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

export class Logger {
    constructor() {
        this.listeners = [];
        this.level = 'debug'; // 日志级别：debug, info, warn, error
        this.recentLogs = [];
        this.maxRecentLogs = 300;
        
        // 创建日志目录
        this.logDir = path.join(ROOT_DIR, 'logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        
        // 日志文件路径（按日期命名）
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        this.logFile = path.join(this.logDir, `mimirlink-${today}.log`);
        
        // 初始化日志文件
        this.initLogFile();
    }
    
    initLogFile() {
        const header = `\n${'='.repeat(80)}\n日志启动时间: ${new Date().toLocaleString('zh-CN')}\n${'='.repeat(80)}\n`;
        fs.appendFileSync(this.logFile, header, FILE_ENCODING);
    }
    
    writeToFile(level, message) {
        const timestamp = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        
        const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
        
        try {
            fs.appendFileSync(this.logFile, logLine, FILE_ENCODING);
        } catch (error) {
            console.error('写入日志文件失败:', error.message);
        }
    }
    
    addListener(callback) {
        this.listeners.push(callback);
    }
    
    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            data
        };

        this.recentLogs.push(logEntry);
        if (this.recentLogs.length > this.maxRecentLogs) {
            this.recentLogs = this.recentLogs.slice(-this.maxRecentLogs);
        }
        
        // 输出到终端
        const color = {
            debug: '\x1b[36m', // 青色
            info: '\x1b[32m',  // 绿色
            warn: '\x1b[33m',  // 黄色
            error: '\x1b[31m'  // 红色
        }[level] || '\x1b[0m';
        
        const reset = '\x1b[0m';
        const time = new Date().toLocaleTimeString('zh-CN');
        console.log(`${color}[${time}] [${level.toUpperCase()}]${reset} ${message}`);
        
        if (data) {
            console.log(data);
        }
        
        // 写入日志文件
        const fullMessage = data ? `${message}\n${JSON.stringify(data, null, 2)}` : message;
        this.writeToFile(level, fullMessage);
        
        // 通知监听器（WebSocket 前端）
        this.listeners.forEach(listener => {
            try {
                listener(logEntry);
            } catch (error) {
                console.error('日志监听器错误:', error);
            }
        });
    }
    
    debug(message, data) {
        if (['debug'].includes(this.level)) {
            this.log('debug', message, data);
        }
    }
    
    info(message, data) {
        if (['debug', 'info'].includes(this.level)) {
            this.log('info', message, data);
        }
    }
    
    warn(message, data) {
        if (['debug', 'info', 'warn'].includes(this.level)) {
            this.log('warn', message, data);
        }
    }
    
    error(message, data) {
        this.log('error', message, data);
    }

    getRecentLogs(limit = 100) {
        return this.recentLogs.slice(-limit);
    }
}

// 添加默认导出（兼容旧的导入方式）
export default Logger;
