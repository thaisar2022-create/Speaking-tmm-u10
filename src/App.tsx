/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  words,
  sentences,
  schoolPhonetics,
  unit10GrammarPatterns,
  qaLessons,
  qaExtra,
  rearrangeLessons,
  quizQuestions,
  blanks,
  fillVocabulary,
  WordItem,
  SentenceItem
} from './data.ts';

// Convert Thai/Arabic numerals to complete Thai number words BEFORE speech synthesis.
function thaiNumberWords(value: string | number): string {
  const digits = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const places = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

  function underMillion(n: number): string {
    if (n === 0) return digits[0];
    let spoken = '';
    for (let place = 5; place >= 0; place--) {
      const digit = Math.floor(n / 10 ** place) % 10;
      if (!digit) continue;
      if (place === 1) {
        spoken += digit === 1 ? 'สิบ' : digit === 2 ? 'ยี่สิบ' : digits[digit] + 'สิบ';
      } else if (place === 0) {
        spoken += digit === 1 && n >= 10 ? 'เอ็ด' : digits[digit];
      } else {
        spoken += digits[digit] + places[place];
      }
    }
    return spoken;
  }

  const s = String(value)
    .replace(/[๐-๙]/g, ch => String(ch.charCodeAt(0) - '๐'.charCodeAt(0)))
    .replace(/,/g, '');

  if (!/^\d+$/.test(s) || s.length > 12) return String(value);
  const n = Number(s);
  if (n < 1000000) return underMillion(n);
  const millions = Math.floor(n / 1000000);
  const rest = n % 1000000;
  return thaiNumberWords(String(millions)) + 'ล้าน' + (rest ? underMillion(rest) : '');
}

function prepareThaiSpeechText(text: string): string {
  return text
    .replace(/[0-9๐-๙][0-9๐-๙,]*/g, n => thaiNumberWords(n))
    .replace(/วันที่\s+(?=[ก-๙])/g, 'วันที่');
}

type Page = 'home' | 'learn' | 'practice' | 'flash' | 'settings';
type LearnTab = 'Words' | 'Sentences' | 'Q & A' | 'Grammar';
type PracticeTab = 'quiz' | 'blank' | 'rearrange';

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [learnTab, setLearnTab] = useState<LearnTab>('Words');
  const [learnIndex, setLearnIndex] = useState(0);
  const [qaIndex, setQaIndex] = useState(0);
  const [flashIndex, setFlashIndex] = useState(0);
  const [flashBack, setFlashBack] = useState(false);
  const [practice, setPractice] = useState<PracticeTab>('quiz');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [fillChoice, setFillChoice] = useState<number | null>(null);
  const [fillChecked, setFillChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizResponses, setQuizResponses] = useState<{ index: number; choice: number; correct: boolean }[]>([]);
  const [reorderIndex, setReorderIndex] = useState(0);
  const [reorderPicked, setReorderPicked] = useState<number[]>([]);
  const [reorderChecked, setReorderChecked] = useState(false);
  const [speed, setSpeed] = useState<number>(() => {
    const s = localStorage.getItem('thaiSpeed');
    return s ? parseFloat(s) : 0.85;
  });
  const [done, setDone] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('thaiDoneUnit10V4') || '[]');
    } catch {
      return [];
    }
  });

  // Recording state
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [audioURLs, setAudioURLs] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<string>('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Total activities count
  const totalActivities = useMemo(() => {
    return words.length + sentences.length + qaLessons.length + rearrangeLessons.length + quizQuestions.length + blanks.length;
  }, []);

  const progressPercent = useMemo(() => {
    return Math.min(100, Math.round((done.length / Math.max(1, totalActivities)) * 100));
  }, [done, totalActivities]);

  const markDone = (key: string) => {
    setDone(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      localStorage.setItem('thaiDoneUnit10V4', JSON.stringify(next));
      return next;
    });
  };

  const speak = (thaiText: string, customRate?: number) => {
    if (!('speechSynthesis' in window)) {
      alert('ဤဖုန်းတွင် စာသားမှ အသံဖတ်သည့်စနစ် မရရှိပါ။');
      return;
    }
    const text = prepareThaiSpeechText(thaiText);
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'th-TH';
    u.rate = customRate || speed;

    const voices = window.speechSynthesis.getVoices();
    const v =
      voices.find(v => v.lang.toLowerCase() === 'th-th') ||
      voices.find(v => v.lang.toLowerCase().startsWith('th'));
    if (v) {
      u.voice = v;
    } else {
      setStatusMsg('Thai voice not found. Your phone may use a fallback voice. For accurate Thai tones, use recorded audio in the production app.');
    }
    window.speechSynthesis.speak(u);
  };

  const toggleRecord = async (id: string) => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setRecordingId(null);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('Recording requires HTTPS (or localhost) and a compatible browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];

      rec.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data);
      };

      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        const url = URL.createObjectURL(blob);
        setAudioURLs(prev => {
          if (prev[id]) URL.revokeObjectURL(prev[id]);
          return { ...prev, [id]: url };
        });
      };

      mediaRecorderRef.current = rec;
      rec.start();
      setRecordingId(id);
    } catch (err: any) {
      alert('Microphone permission unavailable: ' + (err?.message || err));
    }
  };

  const navigateTo = (p: Page) => {
    setPage(p);
    window.scrollTo(0, 0);
  };

  const handleLearnTabChange = (t: LearnTab) => {
    setLearnTab(t);
    setLearnIndex(0);
  };

  const stepLearn = (delta: number) => {
    const arr = learnTab === 'Words' ? words : sentences;
    markDone(`learn-${learnTab}-${learnIndex}`);
    setLearnIndex(prev => (prev + delta + arr.length) % arr.length);
  };

  const stepQA = (delta: number) => {
    markDone(`learn-qa-${qaIndex}`);
    setQaIndex(prev => (prev + delta + qaLessons.length) % qaLessons.length);
  };

  const flipCard = () => {
    setFlashBack(prev => !prev);
    markDone(`card-${flashIndex}`);
  };

  const nextFlash = (delta: number) => {
    setFlashIndex(prev => (prev + delta + words.length) % words.length);
    setFlashBack(false);
  };

  const handleSetPractice = (t: PracticeTab) => {
    setPractice(t);
    setQuestionIndex(0);
    setFillChoice(null);
    setFillChecked(false);
    setQuizScore(0);
    setQuizResponses([]);
    setReorderIndex(0);
    setReorderPicked([]);
    setReorderChecked(false);
  };

  // Rearrange logic
  const currentRearrange = rearrangeLessons[reorderIndex];
  const rearrangeBankOrder = useMemo(() => {
    if (!currentRearrange) return [];
    const n = currentRearrange.parts.length;
    return Array.from({ length: n }, (_, i) => n - 1 - i);
  }, [currentRearrange]);

  const availableRearrangeTokens = useMemo(() => {
    return rearrangeBankOrder.filter(id => !reorderPicked.includes(id));
  }, [rearrangeBankOrder, reorderPicked]);

  const pickRearrange = (id: number) => {
    if (reorderPicked.includes(id) || reorderPicked.length >= currentRearrange.parts.length) return;
    setReorderPicked(prev => [...prev, id]);
    setReorderChecked(false);
  };

  const removeRearrange = (id: number) => {
    setReorderPicked(prev => prev.filter(x => x !== id));
    setReorderChecked(false);
  };

  const checkRearrange = () => {
    if (reorderPicked.length !== currentRearrange.parts.length) return;
    setReorderChecked(true);
    const isCorrect = reorderPicked.every((id, j) => id === j);
    if (isCorrect) {
      markDone(`rearrange-${reorderIndex}`);
    }
  };

  const resetRearrange = () => {
    setReorderPicked([]);
    setReorderChecked(false);
  };

  const nextRearrange = () => {
    setReorderIndex(prev => (prev + 1) % rearrangeLessons.length);
    resetRearrange();
  };

  // Listen & Fill logic
  const currentBlank = blanks[questionIndex % blanks.length];
  const chooseFill = (idx: number) => {
    if (fillChecked) return;
    setFillChoice(idx);
  };

  const checkBlank = () => {
    if (fillChecked || fillChoice === null) return;
    setFillChecked(true);
    if (currentBlank.choices[fillChoice] === currentBlank.answer) {
      markDone(`blank-${questionIndex}`);
    }
  };

  const retryFill = () => {
    setFillChoice(null);
    setFillChecked(false);
  };

  const nextBlank = () => {
    if (fillChecked && fillChoice !== null && currentBlank.choices[fillChoice] === currentBlank.answer) {
      markDone(`blank-${questionIndex}`);
    }
    setQuestionIndex(prev => (prev + 1) % blanks.length);
    setFillChoice(null);
    setFillChecked(false);
  };

  // Quiz logic
  const currentQuiz = quizQuestions[questionIndex];
  const currentQuizResponse = quizResponses.find(x => x.index === questionIndex);

  const chooseQuiz = (choiceIdx: number) => {
    if (currentQuizResponse) return;
    const isCorrect = choiceIdx === currentQuiz.correct;
    setQuizResponses(prev => [...prev, { index: questionIndex, choice: choiceIdx, correct: isCorrect }]);
    if (isCorrect) {
      setQuizScore(s => s + 1);
    }
  };

  const nextQuiz = () => {
    const nextIdx = questionIndex + 1;
    setQuestionIndex(nextIdx);
    if (nextIdx >= quizQuestions.length) {
      markDone('unit10-quiz-completed');
    }
  };

  // Render Action buttons for spoken items
  const renderActions = (thai: string, withRecord = true, recId = 'main') => {
    const isRecording = recordingId === recId;
    return (
      <>
        <div className="controls">
          <button className="btn" onClick={() => speak(thai)}>
            🔊 နားထောင်ပါ
          </button>
          <button className="btn secondary" onClick={() => speak(thai, 0.7)}>
            🐢 ဖြည်းဖြည်း
          </button>
          {withRecord && (
            <button
              className={`btn ghost ${isRecording ? 'recording' : ''}`}
              onClick={() => toggleRecord(recId)}
            >
              {isRecording ? '⏹️ Stop recording' : '🎙️ အသံသွင်းပါ'}
            </button>
          )}
        </div>
        {withRecord && audioURLs[recId] && (
          <div>
            <p className="muted">သင့်အသံကို ပြန်နားထောင်ပါ</p>
            <audio controls src={audioURLs[recId]} />
          </div>
        )}
      </>
    );
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="hero">
        <div className="top">
          <div className="brandwrap">
            <img className="school-logo" src="/school-logo.png" alt="ThaiSar school logo" />
            <div>
              <div className="brand-title">THAISAR</div>
              <div className="logo-label">Thai · Myanmar Speaking School</div>
            </div>
          </div>
          <div className="pill">🇹🇭 + 🇲🇲</div>
        </div>
        <h1>အခန်း (၁၀) · အလုပ်အကိုင်များ</h1>
        <p>Unit 10 · Listening & Speaking · Beginner</p>
        <div className="progress">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="small" style={{ marginTop: '7px', color: '#e2f9f0' }}>
          သင်ယူမှု တိုးတက်မှု · {progressPercent}% ({done.length} activities)
        </div>
      </header>

      {/* Main Content */}
      <main className="content">
        {/* HOME PAGE */}
        {page === 'home' && (
          <div>
            <div className="section-head">
              <h2>စတင်လေ့လာပါ 🌼</h2>
              <span className="muted">အခန်း ၁၀</span>
            </div>
            <div className="notice">
              အသံကို နားထောင်ပါ → လိုက်ပြောပါ → စာကြောင်းကို လေ့ကျင့်ပါ။ ထိုင်းအက္ခရာ အရင်ကျက်ရန် မလိုပါ။
            </div>
            <div className="rows" style={{ marginTop: '14px' }}>
              <button
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  handleLearnTabChange('Words');
                }}
              >
                <span className="emoji">📖</span>
                <strong>စကားလုံးများ</strong>
                <small>Vocabulary · {words.length} items</small>
              </button>
              <button
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  handleLearnTabChange('Sentences');
                }}
              >
                <span className="emoji">🎧</span>
                <strong>ဝါကျများ</strong>
                <small>Listen & repeat · {sentences.length}</small>
              </button>
              <button
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  handleLearnTabChange('Grammar');
                }}
              >
                <span className="emoji">🧩</span>
                <strong>သဒ္ဒါ</strong>
                <small>Tap to see examples</small>
              </button>
              <button
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  handleLearnTabChange('Q & A');
                }}
              >
                <span className="emoji">💬</span>
                <strong>အမေး / အဖြေ</strong>
                <small>19 learn-only dialogue sets</small>
              </button>
              <button
                className="tile"
                onClick={() => {
                  navigateTo('practice');
                  handleSetPractice('quiz');
                }}
              >
                <span className="emoji">📝</span>
                <strong>Unit 10 Quiz</strong>
                <small>12 comprehension questions</small>
              </button>
            </div>

            <h3 style={{ marginTop: '24px' }}>ဒီနေ့ လေ့လာမယ့် ဝါကျ</h3>
            <div className="card">
              <span className="tag">Listen & repeat</span>
              <div className="thai" lang="th">
                {sentences[0][0]}
              </div>
              <div className="phonetic">{sentences[0][1]}</div>
              <div className="mm" lang="my">
                {sentences[0][2]}
              </div>
              {renderActions(sentences[0][0], false)}
            </div>
            <button className="btn wide" onClick={() => navigateTo('learn')}>
              သင်ခန်းစာ စတင်ရန် →
            </button>
          </div>
        )}

        {/* LEARN PAGE */}
        {page === 'learn' && (
          <div>
            {/* Sub Tabs */}
            <div className="controls" style={{ marginBottom: '14px' }}>
              {(['Words', 'Sentences', 'Q & A', 'Grammar'] as LearnTab[]).map(tabName => (
                <button
                  key={tabName}
                  className={`btn ${learnTab === tabName ? '' : 'secondary'}`}
                  onClick={() => handleLearnTabChange(tabName)}
                >
                  {tabName}
                </button>
              ))}
            </div>

            {/* Q & A Tab */}
            {learnTab === 'Q & A' && (
              <div>
                <div className="section-head">
                  <h2>မေးခွန်းနှင့် အဖြေ · Q & A</h2>
                  <span className="counter">
                    {qaIndex + 1} / {qaLessons.length}
                  </span>
                </div>
                <p className="section-intro">
                  ဤစာအုပ်ပါ အမေး/အဖြေ ၁၉ တွဲသည် အခန်း (၁၀) စာအုပ်တွင် ပါရှိသော မူရင်း အမေးအဖြေများဖြစ်သည်။ တစ်ကြောင်းချင်း
                  နားထောင်ပြီး လိုက်ပြောပါ။ ဖြေရန် မလိုပါ။
                </p>
                <div className="card">
                  {/* Question */}
                  <div className="qa-item">
                    <span className="tag">Q · မေးခွန်း</span>
                    <div className="thai" lang="th">
                      {qaLessons[qaIndex][0]}
                    </div>
                    <div className="phonetic">
                      {schoolPhonetics[qaLessons[qaIndex][0]] || ''}
                    </div>
                    <div className="mm" lang="my">
                      {qaLessons[qaIndex][2]}
                    </div>
                    {renderActions(qaLessons[qaIndex][0], true, 'qaQuestion')}
                  </div>

                  <div className="qa-divider">↓ Answer · အဖြေ</div>

                  {/* Answer */}
                  <div className="qa-item">
                    <span className="tag">A · အဖြေ</span>
                    <div className="thai" lang="th">
                      {qaLessons[qaIndex][1]}
                    </div>
                    <div className="phonetic">
                      {schoolPhonetics[qaLessons[qaIndex][1]] || ''}
                    </div>
                    <div className="mm" lang="my">
                      {qaLessons[qaIndex][3]}
                    </div>
                    {renderActions(qaLessons[qaIndex][1], true, 'qaAnswer')}
                  </div>

                  {/* Extra printed answers if any */}
                  {(qaExtra[qaIndex] || []).map((extra, idx) => (
                    <div className="qa-item" key={idx}>
                      <span className="tag">A · အဖြေအပို</span>
                      <div className="thai" lang="th">
                        {extra[0]}
                      </div>
                      <div className="phonetic">{schoolPhonetics[extra[0]] || ''}</div>
                      <div className="mm" lang="my">
                        {extra[1]}
                      </div>
                      {renderActions(extra[0], true, `qaExtra${idx}`)}
                    </div>
                  ))}
                </div>

                <div className="controls">
                  <button className="btn secondary" onClick={() => stepQA(-1)}>
                    ← အရင်တစ်ခု
                  </button>
                  <button className="btn" onClick={() => stepQA(1)}>
                    နောက်တစ်ခု →
                  </button>
                </div>
                {statusMsg && <p className="footnote">{statusMsg}</p>}
              </div>
            )}

            {/* Grammar Tab */}
            {learnTab === 'Grammar' && (
              <div>
                <div className="section-head">
                  <h2>သဒ္ဒါ · Grammar</h2>
                  <span className="counter">{unit10GrammarPatterns.length} patterns</span>
                </div>
                <p className="section-intro">
                  အခန်း (၁၀) စာအုပ်မှ ဝါကျများတွင် ပါဝင်သော သဒ္ဒါပုံစံများကို စုစည်းထားပါသည်။ ခေါင်းစဉ်ကို နှိပ်ပြီး ထိုင်းစာ၊
                  အသံထွက်နှင့် မြန်မာအဓိပ္ပာယ်ကို လေ့လာပါ။
                </p>
                {unit10GrammarPatterns.map((g, j) => {
                  const examples = g.examples
                    .map(t => sentences.find(s => s[0] === t) || words.find(w => w[0] === t))
                    .filter(Boolean) as (WordItem | SentenceItem)[];

                  return (
                    <details className="grammar-accordion" key={j} open={j === 0}>
                      <summary>
                        {j + 1}. {g.title}
                      </summary>
                      <div className="grammar-body">
                        <h3 style={{ marginTop: '15px' }}>{g.formula}</h3>
                        <p className="muted">{g.explain}</p>
                        {examples.map((x, exIdx) => (
                          <div key={exIdx} style={{ padding: '15px 0', borderTop: '1px solid #efe7f1' }}>
                            <div className="thai" style={{ fontSize: '23px' }}>
                              {x[0]}
                            </div>
                            <div className="phonetic">{x[1]}</div>
                            <div className="mm">{x[2]}</div>
                            {renderActions(x[0], false)}
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}

            {/* Words or Sentences Tab */}
            {(learnTab === 'Words' || learnTab === 'Sentences') && (
              <div>
                {(() => {
                  const arr = learnTab === 'Words' ? words : sentences;
                  const item = arr[learnIndex] || arr[0];
                  return (
                    <>
                      <div className="section-head">
                        <h2>နားထောင်ပြီး လိုက်ပြောပါ</h2>
                        <span className="counter">
                          {learnIndex + 1} / {arr.length}
                        </span>
                      </div>
                      <div className="card">
                        <span className="tag">{item[3]}</span>
                        <div className="thai" lang="th">
                          {item[0]}
                        </div>
                        <div className="phonetic">{item[1]}</div>
                        <div className="mm" lang="my">
                          {item[2]}
                        </div>
                        {renderActions(item[0], true, `learn-${learnTab}-${learnIndex}`)}
                      </div>
                      <div className="controls">
                        <button className="btn secondary" onClick={() => stepLearn(-1)}>
                          ← ရှေ့သို့
                        </button>
                        <button className="btn" onClick={() => stepLearn(1)}>
                          နောက်တစ်ခု →
                        </button>
                      </div>
                      {statusMsg && <p className="footnote">{statusMsg}</p>}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* FLASHCARDS PAGE */}
        {page === 'flash' && (
          <div>
            {(() => {
              const w = words[flashIndex];
              return (
                <>
                  <div className="section-head">
                    <h2>Flashcards · မှတ်သားလေ့ကျင့်</h2>
                    <span className="counter">
                      {flashIndex + 1} / {words.length}
                    </span>
                  </div>
                  <div
                    className="card"
                    style={{
                      textAlign: 'center',
                      minHeight: '310px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer'
                    }}
                    onClick={flipCard}
                  >
                    <span className="tag">{flashBack ? 'Meaning' : 'Thai word'}</span>
                    {flashBack ? (
                      <div className="mm" style={{ fontSize: '26px' }}>
                        {w[2]}
                      </div>
                    ) : (
                      <>
                        <div className="thai">{w[0]}</div>
                        <div className="phonetic">{w[1]}</div>
                      </>
                    )}
                    <p className="muted" style={{ marginTop: '16px' }}>
                      ကတ်ကိုနှိပ်ပြီး လှန်ကြည့်ပါ
                    </p>
                  </div>
                  <div className="controls">
                    <button className="btn secondary" onClick={() => speak(w[0])}>
                      🔊 နားထောင်ပါ
                    </button>
                    <button className="btn ghost" onClick={() => nextFlash(-1)}>
                      ← ရှေ့သို့
                    </button>
                    <button className="btn" onClick={() => nextFlash(1)}>
                      နောက်တစ်ခု →
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* PRACTICE PAGE */}
        {page === 'practice' && (
          <div>
            <div className="section-head">
              <h2>Practice · လေ့ကျင့်ခန်း</h2>
            </div>
            <div className="rows practice-tiles">
              <button className="tile" onClick={() => handleSetPractice('quiz')}>
                📝 <strong>Unit 10 Quiz</strong>
                <small>သင်ယူထားသည်ကို စမ်းစစ်ပါ</small>
              </button>
              <button className="tile" onClick={() => handleSetPractice('blank')}>
                🎧 <strong>Listen & Fill</strong>
                <small>နားထောင်ပြီး ဖြည့်ပါ</small>
              </button>
              <button className="tile" onClick={() => handleSetPractice('rearrange')}>
                🧩 <strong>Rearrange Sentence</strong>
                <small>စကားလုံးများကို အစီအစဉ်မှန် စီပါ</small>
              </button>
            </div>

            {/* Quiz Exercise */}
            {practice === 'quiz' && (
              <div id="exercise" style={{ marginTop: '16px' }}>
                {questionIndex >= quizQuestions.length ? (
                  <div className="card quiz-finish">
                    <div className="bigscore">
                      {Math.round((quizScore / quizQuestions.length) * 100)}%
                    </div>
                    <h2>Unit 10 Quiz ပြီးပါပြီ!</h2>
                    <p className="mm">
                      {quizScore} / {quizQuestions.length} မှန်ပါတယ်။
                    </p>
                    <p className="muted">မှားခဲ့သော မေးခွန်းများကို ပြန်ကြည့်ပြီး နောက်တစ်ကြိမ် စမ်းကြည့်နိုင်ပါတယ်။</p>
                    {quizResponses
                      .filter(x => !x.correct)
                      .map((x, revIdx) => (
                        <div className="quiz-review" key={revIdx}>
                          <strong>{quizQuestions[x.index].q}</strong>
                          <p className="muted">{quizQuestions[x.index].why}</p>
                        </div>
                      ))}
                    <button className="btn wide" onClick={() => handleSetPractice('quiz')}>
                      🔄 Quiz ပြန်ဖြေရန်
                    </button>
                  </div>
                ) : (
                  <div className="card">
                    <span className="tag">
                      Unit 10 Quiz · {questionIndex + 1} / {quizQuestions.length}
                    </span>
                    <div className="quiz-progress">
                      <span style={{ width: `${(100 * questionIndex) / quizQuestions.length}%` }} />
                    </div>
                    <h3 className="quiz-question">{currentQuiz.q}</h3>
                    {currentQuiz.audio && (
                      <div className="controls">
                        <button className="btn" onClick={() => speak(currentQuiz.audio!)}>
                          🔊 အသံနားထောင်ပါ
                        </button>
                        <button className="btn secondary" onClick={() => speak(currentQuiz.audio!, 0.7)}>
                          🐢 ဖြည်းဖြည်း
                        </button>
                      </div>
                    )}
                    <div className="stack" style={{ marginTop: '17px' }}>
                      {currentQuiz.choices.map((opt, j) => {
                        let btnClass = 'quiz-option';
                        if (currentQuizResponse) {
                          if (j === currentQuiz.correct) btnClass += ' correct';
                          else if (j === currentQuizResponse.choice) btnClass += ' incorrect';
                        }
                        return (
                          <button
                            key={j}
                            className={btnClass}
                            disabled={!!currentQuizResponse}
                            onClick={() => chooseQuiz(j)}
                          >
                            {String.fromCharCode(65 + j)}. {opt}
                          </button>
                        );
                      })}
                    </div>
                    {currentQuizResponse ? (
                      <>
                        <div className="quiz-feedback">
                          {currentQuizResponse.correct ? '✅ မှန်ပါတယ်!' : '❌ လေ့လာပြီး ထပ်စမ်းကြည့်ပါ။'}
                          <p>{currentQuiz.why}</p>
                        </div>
                        <button className="btn wide" onClick={nextQuiz}>
                          {questionIndex === quizQuestions.length - 1 ? 'ရလဒ် ကြည့်ရန် →' : 'နောက်မေးခွန်း →'}
                        </button>
                      </>
                    ) : (
                      <p className="muted" style={{ marginTop: '12px' }}>
                        အဖြေတစ်ခုကို ရွေးပါ။
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Listen & Fill Exercise */}
            {practice === 'blank' && (
              <div id="exercise" style={{ marginTop: '16px' }}>
                <div className="card fill-card">
                  <span className="tag">
                    🎧 Listen & Fill · {(questionIndex % blanks.length) + 1} / {blanks.length}
                  </span>
                  <p className="section-intro">
                    အသံကို နားထောင်ပြီး အဖြေမှန်ကို ရွေးပါ။ <strong>ထိုင်းစာဖတ်တတ်ရန် မလိုပါ။</strong> ကတ်တစ်ခုစီတွင်
                    ထိုင်းစာ၊ စာအုပ်သုံး phonetic၊ မြန်မာအသံထွက်နှင့် မြန်မာအဓိပ္ပာယ် ပါရှိသည်။
                  </p>
                  <div className="fill-prompt">
                    <span className="fill-prompt-label">မြန်မာအဓိပ္ပာယ်</span>
                    <div className="mm" lang="my">
                      {currentBlank.meaning}
                    </div>
                    <div className="fill-blank-line" lang="th">
                      {currentBlank.blank}
                    </div>
                  </div>
                  <div className="controls">
                    <button className="btn" onClick={() => speak(currentBlank.full)}>
                      🔊 နားထောင်ပါ
                    </button>
                    <button className="btn secondary" onClick={() => speak(currentBlank.full, 0.7)}>
                      🐢 ဖြည်းဖြည်း
                    </button>
                  </div>
                  <h3 className="fill-heading">အဖြေတစ်ခုကို ရွေးပါ။</h3>
                  <div className="fill-options" role="group" aria-label="Listen and Fill multiple choices">
                    {currentBlank.choices.map((word, j) => {
                      const entry = fillVocabulary[word] || ['/--/', '--', '--'];
                      const isCorrect = word === currentBlank.answer;
                      let choiceClass = 'fill-choice';
                      if (fillChecked) {
                        if (isCorrect) choiceClass += ' is-correct';
                        else if (fillChoice === j) choiceClass += ' is-wrong';
                      } else if (fillChoice === j) {
                        choiceClass += ' is-selected';
                      }

                      return (
                        <button
                          key={j}
                          type="button"
                          className={choiceClass}
                          onClick={() => chooseFill(j)}
                          disabled={fillChecked}
                          aria-pressed={fillChoice === j}
                        >
                          <span className="fill-number">{String.fromCharCode(65 + j)}</span>
                          <span className="fill-lines">
                            <span className="fill-thai" lang="th">
                              {word}
                            </span>
                            <span className="fill-phonetic">{entry[0]}</span>
                            <span className="fill-pronunciation" lang="my">
                              {entry[1]}
                            </span>
                            <span className="fill-meaning" lang="my">
                              {entry[2]}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {!fillChecked ? (
                    <button className="btn wide" onClick={checkBlank} disabled={fillChoice === null}>
                      အဖြေစစ်ဆေးပါ
                    </button>
                  ) : (
                    <div
                      className={`fill-feedback ${
                        currentBlank.choices[fillChoice!] === currentBlank.answer ? 'good' : 'retry'
                      }`}
                      role="status"
                    >
                      <strong>
                        {currentBlank.choices[fillChoice!] === currentBlank.answer
                          ? '✅ မှန်ပါတယ်!'
                          : '📖 အဖြေမှန်ကို လေ့လာပါ။'}
                      </strong>
                      <p>
                        {currentBlank.choices[fillChoice!] === currentBlank.answer
                          ? 'အသံကို မှန်ကန်စွာ ရွေးချယ်နိုင်ပါတယ်။'
                          : 'မှားသောအဖြေကို ပြထားပြီး အဖြေမှန်ကို အစိမ်းရောင်ဖြင့် ပြထားပါတယ်။'}
                      </p>
                      <div className="fill-fully">
                        <div className="thai" lang="th">
                          {currentBlank.full}
                        </div>
                        <div className="phonetic">{schoolPhonetics[currentBlank.full] || ''}</div>
                        <div className="mm" lang="my">
                          {currentBlank.meaning}
                        </div>
                      </div>
                      <div className="controls" style={{ marginTop: '12px' }}>
                        <button className="btn secondary" onClick={retryFill}>
                          ↺ ပြန်လေ့ကျင့်ရန်
                        </button>
                        <button className="btn" onClick={nextBlank}>
                          {questionIndex % blanks.length === blanks.length - 1
                            ? 'အစက ပြန်လေ့ကျင့်ရန်'
                            : 'နောက်မေးခွန်း →'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Rearrange Sentence Exercise */}
            {practice === 'rearrange' && (
              <div id="exercise" style={{ marginTop: '16px' }}>
                {(() => {
                  const lesson = currentRearrange;
                  const picked = reorderPicked;
                  const available = availableRearrangeTokens;
                  const complete = picked.length === lesson.parts.length;
                  const correct = reorderChecked && complete && picked.every((id, j) => id === j);

                  return (
                    <div className="card">
                      <span className="tag">
                        Rearrange Sentence · {reorderIndex + 1} / {rearrangeLessons.length}
                      </span>
                      <p className="section-intro">
                        မြန်မာအဓိပ္ပာယ်ကို ဖတ်ပြီး ထိုင်းစကားလုံးများကို အစီအစဉ်မှန် စီပါ။ ကတ်တစ်ခုစီတွင် ထိုင်းစာ၊ စာအုပ်သုံး
                        phonetic နှင့် မြန်မာအသံထွက် ပါရှိသည်။
                      </p>
                      <div className="reorder-prompt">
                        <strong>မြန်မာအဓိပ္ပာယ်</strong>
                        <div className="mm">{lesson.meaning}</div>
                      </div>
                      <div className="controls">
                        <button
                          className="btn secondary"
                          onClick={() => speak(lesson.parts.map(p => p[0]).join(''))}
                        >
                          🔊 နားထောင်ပါ
                        </button>
                        <button
                          className="btn ghost"
                          onClick={() => speak(lesson.parts.map(p => p[0]).join(''), 0.7)}
                        >
                          🐢 အနှေးအသံ
                        </button>
                      </div>

                      {/* 1. Answer area */}
                      <div className="reorder-area">
                        <h4>၁။ စီထားသော စကားလုံးများ (နှိပ်၍ ပြန်ဖြုတ်နိုင်ပါသည်)</h4>
                        <div className="reorder-tiles" id="reorderAnswer">
                          {picked.length === 0 ? (
                            <div className="reorder-empty">အောက်က ကတ်များကို အစဉ်လိုက် နှိပ်ပါ။</div>
                          ) : (
                            picked.map(id => {
                              const part = lesson.parts[id];
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  className="reorder-token selected"
                                  onClick={() => removeRearrange(id)}
                                  aria-label={`Remove ${part[0]}`}
                                >
                                  <span className="reorder-thai" lang="th">
                                    {part[0]}
                                  </span>
                                  <span className="reorder-phon">{part[1]}</span>
                                  <span className="reorder-my" lang="my">
                                    {part[2]}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>

                      {/* 2. Word bank */}
                      <div className="reorder-bank">
                        <h4>၂။ စကားလုံးကတ်များ</h4>
                        <div className="reorder-tiles" id="reorderChoices">
                          {available.length === 0 ? (
                            <span className="muted">စကားလုံးအားလုံး စီပြီးပါပြီ။</span>
                          ) : (
                            available.map(id => {
                              const part = lesson.parts[id];
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  className="reorder-token"
                                  onClick={() => pickRearrange(id)}
                                  aria-label={`Choose ${part[0]}`}
                                >
                                  <span className="reorder-thai" lang="th">
                                    {part[0]}
                                  </span>
                                  <span className="reorder-phon">{part[1]}</span>
                                  <span className="reorder-my" lang="my">
                                    {part[2]}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>

                      {/* Status Feedback */}
                      {reorderChecked && (
                        <>
                          {correct ? (
                            <>
                              <div className="reorder-status good" role="status">
                                <strong>✅ မှန်ပါတယ်!</strong> စာကြောင်းကို မှန်ကန်စွာ စီထားပါတယ်။
                              </div>
                              <div className="reorder-complete">
                                <div className="thai" lang="th">
                                  {lesson.parts.map(p => p[0]).join('')}
                                </div>
                                <div className="phonetic">
                                  {`/${lesson.parts.map(p => p[1].replaceAll('/', '')).join('-')}/`}
                                </div>
                                <div className="mm">{lesson.meaning}</div>
                              </div>
                            </>
                          ) : (
                            <div className="reorder-status try" role="status">
                              အစီအစဉ် မမှန်သေးပါ။ စကားလုံးကို နှိပ်ပြီး ပြန်ရွှေ့နိုင်ပါတယ်။
                            </div>
                          )}
                        </>
                      )}

                      {/* Rearrange Controls */}
                      <div className="reorder-controls">
                        <button className="btn secondary" onClick={resetRearrange}>
                          ↺ ပြန်စီရန်
                        </button>
                        {correct ? (
                          <button className="btn" onClick={nextRearrange}>
                            {reorderIndex === rearrangeLessons.length - 1 ? 'နောက်တစ်ကြိမ် လေ့ကျင့်ရန်' : 'နောက်ဝါကျ →'}
                          </button>
                        ) : (
                          <button className="btn" onClick={checkRearrange} disabled={!complete}>
                            ✓ အဖြေစစ်ရန်
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* SETTINGS PAGE */}
        {page === 'settings' && (
          <div>
            <h2>⚙️ အသံနှင့် app settings</h2>
            <div className="card">
              <h3>Thai voice · အသံ</h3>
              <p className="muted">Thai voice selection depends on the browser and operating system.</p>
              <div className="notice" style={{ margin: '10px 0' }}>
                {(() => {
                  const vs = window.speechSynthesis?.getVoices?.() || [];
                  const thaiVoices = vs.filter(x => x.lang.toLowerCase().startsWith('th'));
                  return thaiVoices.length > 0
                    ? thaiVoices.map(x => `${x.name} (${x.lang})`).join(', ')
                    : 'System Thai voice ready (uses system default or online Thai speech).';
                })()}
              </div>
              <label htmlFor="rate" style={{ display: 'block', marginTop: '12px' }}>
                Audio speed · <span id="speedLabel">{speed}</span>×
              </label>
              <input
                id="rate"
                type="range"
                min="0.5"
                max="1.1"
                step="0.05"
                value={speed}
                style={{ width: '100%', margin: '10px 0' }}
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  setSpeed(val);
                  localStorage.setItem('thaiSpeed', String(val));
                }}
              />
              <div className="controls">
                <button className="btn" onClick={() => speak('สวัสดีครับ')}>
                  🔊 Thai အသံ စမ်းနားထောင်ရန်
                </button>
              </div>
            </div>

            <div className="card">
              <h3>Install on phone</h3>
              <p className="muted">
                Open the hosted site in Chrome on Android or Safari on iPhone, then use Add to Home Screen / Install
                App.
              </p>
              <p className="small">
                A PWA needs HTTPS or localhost. The current downloaded HTML file can be opened as a preview, but
                installation and offline caching require hosting.
              </p>
            </div>

            <div className="card">
              <h3>Student progress</h3>
              <p className="muted">Saved on this device, not synchronized with a school account.</p>
              <button
                className="btn secondary"
                onClick={() => {
                  if (window.confirm('Reset your progress?')) {
                    setDone([]);
                    localStorage.removeItem('thaiDoneUnit10V4');
                  }
                }}
              >
                Reset progress
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Bottom Fixed Navigation Bar */}
      <nav className="nav" id="nav">
        <button
          className={page === 'home' ? 'active' : ''}
          onClick={() => navigateTo('home')}
        >
          <span className="ico">⌂</span>ပင်မ
        </button>
        <button
          className={page === 'learn' ? 'active' : ''}
          onClick={() => navigateTo('learn')}
        >
          <span className="ico">◉</span>လေ့လာ
        </button>
        <button
          className={page === 'practice' ? 'active' : ''}
          onClick={() => navigateTo('practice')}
        >
          <span className="ico">✦</span>လေ့ကျင့်
        </button>
        <button
          className={page === 'flash' ? 'active' : ''}
          onClick={() => navigateTo('flash')}
        >
          <span className="ico">▣</span>ကတ်များ
        </button>
        <button
          className={page === 'settings' ? 'active' : ''}
          onClick={() => navigateTo('settings')}
        >
          <span className="ico">⚙</span>ချိန်ညှိ
        </button>
      </nav>
    </div>
  );
}
