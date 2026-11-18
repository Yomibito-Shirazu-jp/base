import { GoogleGenAI } from '@google/genai';

export type GeminiChatModel = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

export interface GroundingSource {
  title: string;
  uri: string;
}

let cachedAi: GoogleGenAI | null = null;
let cachedApiKey: string | null = null;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY が設定されていません。Settings > Secrets パネルを確認してください。');
  }
  if (!cachedAi || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedAi = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedAi;
}

function formatGeminiError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('API_KEY_INVALID') || raw.includes('API key not valid') || raw.includes('PERMISSION_DENIED')) {
    return new Error('Gemini API キーが無効または権限がありません。Settings > Secrets パネルで GEMINI_API_KEY を確認してください。');
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return new Error('Gemini API の利用上限に達しました。しばらく待ってから再試行するか、Settings > Secrets でキーを確認してください。');
  }
  if (raw.includes('NOT_FOUND') || raw.includes('404')) {
    return new Error('指定された Gemini モデルが見つかりません。モデル設定を確認してください。');
  }
  return err instanceof Error ? err : new Error(raw || 'Gemini API 呼び出しに失敗しました');
}

const AUDITOR_SYSTEM_INSTRUCTION = `あなたは Base (OP Stack) オンチェーン検証および L2→L1 出金監査の専門アシスタントです。
以下の正確な技術仕様に基づいて日本語で明確・簡潔に回答してください：
- Base (OP Stack) のトランザクションは「Latest (Unsafe, L2シーケンサー即時承認 ~2秒) → Safe (L1バッチ投稿済) → Finalized (L1 Casper FFG 確定 ~13〜15分)」の3段階で確定する。
- 注意: L2ブロックが Finalized になっても、L2→L1 出金トランザクション（L2ToL1MessagePasser）は自動着金しない。L1 の OptimismPortal2 で proveWithdrawalTransaction（証明提出）と、proofMaturityDelaySeconds（現在 Base Mainnet では 86,400秒＝24時間）待機後の finalizeWithdrawalTransaction（Claim実行）が行われて初めて finalizedWithdrawals(withdrawalHash) == true となる。
- ユーザーの検証コンソールから渡されたコンテキスト（チェーンヘッド・検証済みTx・出金状態・情報の信頼性分類）がある場合は、その実測値を優先して説明すること。
- Google Search Grounding が有効な場合は最新の公式仕様・ステータス・アップデートを検索して根拠URLとともに回答すること。`;

function extractGroundingSources(response: unknown): GroundingSource[] {
  const candidate = (
    response as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
    }
  )?.candidates?.[0];

  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];

  for (const ch of chunks) {
    const uri = ch.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({
      title: ch.web?.title || uri,
      uri,
    });
  }

  return sources;
}

export async function runMultiTurnAuditChat(params: {
  model?: GeminiChatModel;
  history: Array<{ role: 'user' | 'model'; content: string }>;
  message: string;
  contextSummary?: string;
  useGoogleSearch?: boolean;
}): Promise<{
  text: string;
  modelUsed: GeminiChatModel;
  groundingSources: GroundingSource[];
}> {
  const ai = getAiClient();
  const modelUsed: GeminiChatModel =
    params.model === 'gemini-3.1-flash-lite'
      ? 'gemini-3.1-flash-lite'
      : 'gemini-4-hydrogen';

  const systemInstruction = params.contextSummary
    ? `${AUDITOR_SYSTEM_INSTRUCTION}\n\n[現在の検証セッション実測コンテキスト]\n${params.contextSummary}`
    : AUDITOR_SYSTEM_INSTRUCTION;

  const rawHistory = params.history.filter(
    (h) => h.content && h.content.trim().length > 0
  );
  const alternatingHistory: Array<{ role: 'user' | 'model'; content: string }> = [];
  for (const item of rawHistory) {
    const prev = alternatingHistory[alternatingHistory.length - 1];
    if (prev && prev.role === item.role) {
      prev.content = `${prev.content}\n\n${item.content}`;
    } else if (!prev && item.role !== 'user') {
      continue;
    } else {
      alternatingHistory.push({ role: item.role, content: item.content });
    }
  }
  while (
    alternatingHistory.length > 0 &&
    alternatingHistory[alternatingHistory.length - 1].role === 'user'
  ) {
    alternatingHistory.pop();
  }

  const formattedHistory = alternatingHistory.slice(-20).map((h) => ({
    role: h.role,
    parts: [{ text: h.content }],
  }));

  try {
    const chat = ai.chats.create({
      model: modelUsed,
      history: formattedHistory,
      config: {
        systemInstruction,
        ...(params.useGoogleSearch !== false && modelUsed === 'gemini-4-hydrogen'
          ? { tools: [{ googleSearch: {} }] }
          : {}),
      },
    });

    const response = await chat.sendMessage({
      message: params.message,
    });

    return {
      text: (response.text ?? '').trim() || '回答を生成できませんでした。',
      modelUsed,
      groundingSources: extractGroundingSources(response),
    };
  } catch (err) {
    throw formatGeminiError(err);
  }
}

export async function runGroundedProtocolSearch(query: string): Promise<{
  text: string;
  groundingSources: GroundingSource[];
}> {
  const ai = getAiClient();
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Base (Ethereum L2 / OP Stack) ネットワークおよび出金プロトコルに関する次の質問について、最新情報を検索し、正確かつ簡潔に日本語で回答してください:\n\n${query}`,
      config: {
        systemInstruction: AUDITOR_SYSTEM_INSTRUCTION,
        tools: [{ googleSearch: {} }],
      },
    });

    return {
      text: (response.text ?? '').trim() || '検索結果から要約を生成できませんでした。',
      groundingSources: extractGroundingSources(response),
    };
  } catch (err) {
    throw formatGeminiError(err);
  }
}
