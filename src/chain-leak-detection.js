const ENGLISH_OR_CODE_REQUEST_RE = /(英文|英语|英語|English|translate|翻译|翻譯|英译|英譯|中译英|中譯英|输出英文|用英文|英文版|prompt|提示词|提示詞|正则|正規|regex|代码|代碼|code|JSON|SQL|JavaScript|TypeScript|Python|HTML|CSS|bash|shell|PowerShell|脚本|腳本|函数|函式|日志|log|stack trace|traceback)/i;

const LEAK_PHRASE_RE = /\b(?:I(?:'m| am) (?:currently )?(?:analyzing|analysing|evaluating|reviewing|refining|considering|determining|assessing|focusing|tracking|formulating|crafting|checking|identifying|thinking|trying)|My current focus is|My focus is|I need to (?:analyze|analyse|determine|figure out|decide|craft|formulate|respond|answer|ensure|avoid)|I will (?:analyze|analyse|determine|figure out|decide|craft|formulate|respond|answer)|The user (?:is|wants|asked|seems|appears)|the user's (?:intent|request|message)|I should (?:respond|answer|avoid|ensure|mention|keep|make)|I'll (?:respond|answer|craft|keep|make|avoid|ensure))\b/i;

const REASONING_KEYWORDS_RE = /\b(?:analyzing|analysing|evaluating|reviewing|refining|considering|determining|assessing|focusing|tracking|formulating|crafting|context|intent|speaker|response|reply|strategy|prompt|persona|roleplay|conversation|user's request|current message)\b/i;
const MARKDOWN_ENGLISH_HEADING_RE = /^\s*\*\*[A-Z][A-Za-z0-9 ,:'’\-()]{5,90}\*\*/m;

function normalizeText(text) {
    return String(text || '').replace(/\r/g, '').trim();
}

function hasExplicitEnglishOrCodeRequest(userInput) {
    return ENGLISH_OR_CODE_REQUEST_RE.test(normalizeText(userInput));
}

function hasFencedCodeBlock(text) {
    return /```[\s\S]*?```/.test(normalizeText(text));
}

function looksLikeCode(text) {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    if (hasFencedCodeBlock(normalized)) return true;

    const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
    const codeLines = lines.filter(line => (
        /^(?:import|export|const|let|var|function|class|def|async function|return|if|else|for|while|try|catch|finally|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE)\b/i.test(line)
        || /^[}\]);]+$/.test(line)
        || /^[A-Za-z_$][\w$]*\s*=\s*.+;?$/.test(line)
        || /^[A-Za-z_$][\w$]*\([^)]*\);?$/.test(line)
        || /[{}();=<>]\s*$/.test(line) && /\b(?:const|let|var|return|if|for|while|class|function|def|SELECT|FROM|WHERE)\b/i.test(line)
        || /^\s*["'][A-Za-z0-9_.-]+["']\s*:/.test(line)
    ));

    return codeLines.length >= 2 && codeLines.length / Math.max(lines.length, 1) >= 0.35;
}

function englishRatio(text) {
    const normalized = normalizeText(text);
    if (!normalized) return 0;
    const asciiLetters = (normalized.match(/[A-Za-z]/g) || []).length;
    const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
    return asciiLetters / Math.max(asciiLetters + cjkChars, 1);
}

function collectCandidateText({ rawReply, visibleReply, processedReply } = {}) {
    return [rawReply, visibleReply, processedReply]
        .map(normalizeText)
        .filter(Boolean)
        .join('\n\n');
}

export function detectChainLeak({ rawReply, visibleReply, processedReply, userInput } = {}) {
    const candidate = collectCandidateText({ rawReply, visibleReply, processedReply });
    if (!candidate) {
        return { leaked: false, reason: 'empty' };
    }

    if (hasExplicitEnglishOrCodeRequest(userInput)) {
        return { leaked: false, reason: 'user-requested-english-or-code' };
    }

    if (looksLikeCode(candidate)) {
        return { leaked: false, reason: 'code-like-output' };
    }

    if (LEAK_PHRASE_RE.test(candidate)) {
        return { leaked: true, reason: 'english-reasoning-phrase' };
    }

    if (MARKDOWN_ENGLISH_HEADING_RE.test(candidate) && REASONING_KEYWORDS_RE.test(candidate)) {
        return { leaked: true, reason: 'english-markdown-reasoning-heading' };
    }

    const ratio = englishRatio(candidate);
    const words = candidate.match(/[A-Za-z]{3,}/g) || [];
    if (ratio >= 0.62 && words.length >= 18 && REASONING_KEYWORDS_RE.test(candidate)) {
        return { leaked: true, reason: 'high-english-reasoning-density' };
    }

    return { leaked: false, reason: 'no-strong-signal' };
}

export function buildChainLeakRetryMessage(reason = '') {
    const suffix = reason ? ` 检测原因：${reason}。` : '';
    return [
        '上一轮输出疑似把模型内部分析/英文工作日志当成最终回复泄露。请重新生成。',
        suffix,
        '要求：完整输出 <thinking>中文方圆内心独白</thinking>，然后只输出徐缺发到 QQ 的一句正文；不要输出英文分析标题、模型工作日志、字段报告或作者口吻。',
        '如果用户明确要求英文、翻译、prompt 或代码，则按用户要求输出正文，但仍不要输出模型工作日志。'
    ].join('');
}
