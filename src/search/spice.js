/**
 * DuckDuckGo Spice 即时数据（天气 / 汇率）
 * 移植自 duck-duck-scrape 的 spice 调用方式（MIT），并按 2026-09 实测的新数据结构解析：
 * - forecast 返回 Apple WeatherKit 结构（currentWeather / forecastDaily.days）
 * - currency 返回 xe.com 中间价结构
 */

import { requestText, isAbortError } from './http.js';

const SPICE_BASE = 'https://duckduckgo.com/js/spice';
const SPICE_WRAPPER_REGEX = /^ddg_spice_[\w]+\(\n?([\s\S]+?)\n?\);?\s*$/;

const CONDITION_ZH = {
    Clear: '晴',
    MostlyClear: '晴间多云',
    PartlyCloudy: '多云',
    MostlyCloudy: '多云转阴',
    Cloudy: '阴',
    Fog: '雾',
    Haze: '霾',
    Smoke: '烟霾',
    Breezy: '微风',
    Windy: '大风',
    Drizzle: '毛毛雨',
    FreezingDrizzle: '冻毛毛雨',
    Rain: '雨',
    HeavyRain: '大雨',
    FreezingRain: '冻雨',
    MixedRainAndSleet: '雨夹雪',
    MixedRainAndSnow: '雨夹雪',
    MixedSnowAndSleet: '雪夹雨',
    ScatteredShowers: '零星阵雨',
    ScatteredThunderstorms: '零星雷阵雨',
    Thunderstorms: '雷阵雨',
    IsolatedThunderstorms: '局部雷阵雨',
    StrongStorms: '强雷暴',
    Snow: '雪',
    Flurries: '阵雪',
    HeavySnow: '大雪',
    Blizzard: '暴风雪',
    BlowingSnow: '吹雪',
    WintryMix: '冬季混合降水',
    Hail: '冰雹',
    Sleet: '雨夹雪',
    TropicalStorm: '热带风暴',
    Hurricane: '飓风',
    Hot: '炎热',
    Cold: '寒冷',
    Frigid: '严寒',
    Freezing: '冰冻'
};

function describeCondition(code) {
    const key = String(code || '').trim();
    return CONDITION_ZH[key] || key || '未知';
}

function formatNumber(value, digits = 1) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return '—';
    }
    return normalized.toFixed(digits).replace(/\.0+$/, '');
}

function formatPercent(value) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return '—';
    }
    const percent = normalized <= 1 ? normalized * 100 : normalized;
    return `${Math.round(percent)}%`;
}

function formatDateLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value || '');
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

async function fetchSpice(path, { timeoutMs = 10000, signal } = {}) {
    let response;
    try {
        response = await requestText(`${SPICE_BASE}/${path}`, {
            headers: { Accept: 'application/json,text/javascript,*/*' },
            timeoutMs,
            signal
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throw new Error(`DuckDuckGo spice 请求失败: ${error.message}`);
    }

    if (!response.ok) {
        throw new Error(`DuckDuckGo spice 返回 HTTP ${response.status}`);
    }

    const text = String(response.text || '').trim();
    if (/^ddg_spice_\w+\(\s*\)/.test(text)) {
        return null;
    }
    const match = SPICE_WRAPPER_REGEX.exec(text);
    if (!match) {
        throw new Error('DuckDuckGo spice 响应格式无法解析');
    }
    try {
        return JSON.parse(match[1]);
    } catch {
        throw new Error('DuckDuckGo spice 响应不是合法 JSON');
    }
}

/**
 * 查询指定地点的天气（DuckDuckGo 天气卡片数据源）。
 * @param {{location:string, days?:number, locale?:string, timeoutMs?:number, signal?:AbortSignal}} options
 */
export async function fetchWeather({ location, days = 3, locale = 'zh-cn', timeoutMs = 10000, signal } = {}) {
    const query = String(location || '').trim();
    if (!query) {
        throw new Error('地点不能为空');
    }

    const payload = await fetchSpice(`forecast/${encodeURIComponent(query)}/${encodeURIComponent(locale || 'zh-cn')}`, { timeoutMs, signal });
    if (!payload) {
        return { ok: false, location: query, error: `未找到「${query}」的天气数据，请换一个更明确的地点名称` };
    }

    const current = payload.currentWeather || {};
    const allDays = Array.isArray(payload.forecastDaily?.days) ? payload.forecastDaily.days : [];
    const dayLimit = Math.max(1, Math.min(7, Number(days) || 3));
    const daily = allDays.slice(0, dayLimit).map((day) => ({
        date: day.forecastStart || day.date || '',
        condition: describeCondition(day.conditionCode),
        conditionCode: day.conditionCode || '',
        temperatureMax: Number(day.temperatureMax),
        temperatureMin: Number(day.temperatureMin),
        precipitationChancePercent: formatPercent(day.daytimeForecast?.precipitationChance ?? day.precipitationChance)
    }));

    const locationName = payload.location?.name || query;
    const timezone = payload.timezone || '';
    const lines = [
        `${locationName}${timezone ? `（时区 ${timezone}）` : ''} 当前天气：${describeCondition(current.conditionCode)}，气温 ${formatNumber(current.temperature)}℃，体感 ${formatNumber(current.temperatureApparent)}℃，湿度 ${formatPercent(current.humidity)}，风速 ${formatNumber(current.windSpeed)} km/h${Number.isFinite(Number(current.uvIndex)) ? `，紫外线指数 ${formatNumber(current.uvIndex, 0)}` : ''}。`
    ];
    if (daily.length > 0) {
        lines.push(`未来 ${daily.length} 天：`);
        for (const day of daily) {
            lines.push(`- ${formatDateLabel(day.date)}：${day.condition}，${formatNumber(day.temperatureMin)} ~ ${formatNumber(day.temperatureMax)}℃，降水概率 ${day.precipitationChancePercent}`);
        }
    }
    lines.push('数据来源：DuckDuckGo 天气（Apple WeatherKit）');

    return {
        ok: true,
        location: locationName,
        timezone,
        current: {
            asOf: current.asOf || '',
            condition: describeCondition(current.conditionCode),
            conditionCode: current.conditionCode || '',
            temperature: Number.isFinite(Number(current.temperature)) ? Number(current.temperature) : null,
            temperatureApparent: Number.isFinite(Number(current.temperatureApparent)) ? Number(current.temperatureApparent) : null,
            humidityPercent: formatPercent(current.humidity),
            windSpeedKmh: Number.isFinite(Number(current.windSpeed)) ? Number(current.windSpeed) : null,
            windGustKmh: Number.isFinite(Number(current.windGust)) ? Number(current.windGust) : null,
            uvIndex: Number.isFinite(Number(current.uvIndex)) ? Number(current.uvIndex) : null,
            precipitationIntensity: Number.isFinite(Number(current.precipitationIntensity)) ? Number(current.precipitationIntensity) : null,
            cloudCoverPercent: formatPercent(current.cloudCover),
            pressure: Number.isFinite(Number(current.pressure)) ? Number(current.pressure) : null,
            visibility: Number.isFinite(Number(current.visibility)) ? Number(current.visibility) : null,
            daylight: Boolean(current.daylight)
        },
        daily,
        summary: lines.join('\n'),
        source: 'duckduckgo_weather'
    };
}

/**
 * 汇率换算（DuckDuckGo 汇率卡片，数据源 xe.com 中间价）。
 */
export async function fetchCurrency({ from, to, amount = 1, timeoutMs = 10000, signal } = {}) {
    const fromCode = String(from || '').trim().toUpperCase();
    const toCode = String(to || '').trim().toUpperCase();
    const normalizedAmount = Number(amount);
    if (!fromCode || !toCode) {
        throw new Error('需要提供源货币和目标货币，例如 USD 与 CNY');
    }
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('金额必须是正数');
    }

    const payload = await fetchSpice(`currency/${encodeURIComponent(normalizedAmount)}/${encodeURIComponent(fromCode)}/${encodeURIComponent(toCode)}`, { timeoutMs, signal });
    const quote = Array.isArray(payload?.to) ? payload.to[0] : null;
    // 实测（2026-09）：DDG 返回的 mid 是「已换算金额」，不是单位汇率，需要除以请求金额还原
    const converted = Number(quote?.mid);
    const baseAmount = Number(payload?.amount) || normalizedAmount;
    const rate = Number.isFinite(converted) && baseAmount > 0 ? converted / baseAmount : NaN;
    if (!payload || !Number.isFinite(converted) || !Number.isFinite(rate)) {
        return { ok: false, from: fromCode, to: toCode, error: `未找到 ${fromCode} → ${toCode} 的汇率数据` };
    }

    return {
        ok: true,
        from: fromCode,
        to: toCode,
        amount: normalizedAmount,
        rate,
        converted,
        timestamp: payload.timestamp || '',
        summary: `${formatNumber(normalizedAmount, 2)} ${fromCode} ≈ ${formatNumber(converted, 4)} ${toCode}（1 ${fromCode} = ${formatNumber(rate, 6)} ${toCode}，数据源 xe.com 中间价${payload.timestamp ? `，${payload.timestamp}` : ''}）`,
        source: 'duckduckgo_currency'
    };
}
