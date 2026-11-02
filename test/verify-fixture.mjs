// Fake models answer Echo's independent-verifier requests like a real model would,
// so tests that count agent turns stay about agent turns.
export const isVerify = body => /^You are an independent verifier/.test(body?.systemInstruction?.parts?.[0]?.text ?? '');
export const verifyReply = (result = { claims: [], argument: [], tone: { fits: true } }) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(result) }] } }] });
