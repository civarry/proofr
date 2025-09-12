class APIKeyManager {
  static async getAPIKey() {
    const result = await chrome.storage.sync.get(['groqAPIKey']);
    return result.groqAPIKey || null;
  }

  static async setAPIKey(apiKey) {
    await chrome.storage.sync.set({ groqAPIKey: apiKey });
  }

  static async hasAPIKey() {
    const apiKey = await this.getAPIKey();
    return apiKey && apiKey.trim().length > 0;
  }

  static async clearAPIKey() {
    await chrome.storage.sync.remove(['groqAPIKey']);
  }
}

class StatsManager {
  static async getStats() {
    const result = await chrome.storage.local.get(['rewriteStats']);
    return result.rewriteStats || {
      totalRewrites: 0,
      styleUsage: {},
      lastUsed: null
    };
  }

  static async updateStats(style) {
    const stats = await this.getStats();
    stats.totalRewrites++;
    stats.styleUsage[style] = (stats.styleUsage[style] || 0) + 1;
    stats.lastUsed = Date.now();
    
    await chrome.storage.local.set({ rewriteStats: stats });
    return stats;
  }
}

function isValidGroqAPIKey(apiKey) {
  return apiKey && apiKey.startsWith("gsk_") && apiKey.length >= 40;
}

async function validateAPIKey(apiKey) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    return response.ok;
  } catch (error) {
    console.error("API key validation error:", error);
    return false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "smartRewrite",
    title: "Smart Rewrite",
    contexts: ["selection"]
  });

  const rewriteModes = [
    { id: "rewriteFriendly", title: "🤝 Friendly Tone" },
    { id: "rewriteProfessional", title: "👔 Professional Tone" },
    { id: "rewriteShort", title: "⚡ Concise Rewrite" },
    { id: "rewriteLinkedin", title: "💼 LinkedIn Ready" },
    { id: "rewriteAcademic", title: "🎓 Academic Style" },
    { id: "rewriteMarketing", title: "📢 Marketing Copy" },
    { id: "rewriteSimple", title: "📖 Plain English" },
    { id: "rewriteExecutive", title: "📊 Executive Brief" },
    { id: "rewriteEnglish", title: "🔠 Translate" }
  ];

  rewriteModes.forEach(mode => {
    chrome.contextMenus.create({
      id: mode.id,
      parentId: "smartRewrite",
      title: mode.title,
      contexts: ["selection"]
    });
  });

  chrome.contextMenus.create({
    id: "separator1",
    parentId: "smartRewrite",
    type: "separator",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "openSettings",
    parentId: "smartRewrite",
    title: "⚙️ Settings",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "openSettings") {
    chrome.action.openPopup();
    return;
  }

  if (info.menuItemId.startsWith("rewrite")) {
    try {
      const hasKey = await APIKeyManager.hasAPIKey();
      if (!hasKey) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: showErrorMessage,
          args: ["Please set your Groq API key in the extension popup first! Click the extension icon to get started."]
        });
        return;
      }

      const tone = info.menuItemId.replace("rewrite", "").toLowerCase();
      const text = info.selectionText;

      if (!text || text.trim().length === 0) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: showErrorMessage,
          args: ["Please select some text first!"]
        });
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLoadingModal,
        args: [text, tone]
      });

      const rewritten = await callGroqAPI(text, tone);
      
      await StatsManager.updateStats(tone);

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showRewriteResult,
        args: [text, rewritten, tone]
      });

    } catch (error) {
      console.error("Error rewriting text:", error);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showErrorMessage,
        args: [error.message]
      });
    }
  }
});

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === 'quickRewrite') {
    try {
      const hasKey = await APIKeyManager.hasAPIKey();
      if (!hasKey) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          func: showErrorMessage,
          args: ["Please set your Groq API key first!"]
        });
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showLoadingModal,
        args: [message.text, message.tone]
      });

      const rewritten = await callGroqAPI(message.text, message.tone);
      await StatsManager.updateStats(message.tone);

      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showRewriteResult,
        args: [message.text, rewritten, message.tone]
      });

    } catch (error) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showErrorMessage,
        args: [error.message]
      });
    }
  } else if (message.action === 'rewriteWithTone') {
    try {
      const hasKey = await APIKeyManager.hasAPIKey();
      if (!hasKey) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          func: showErrorMessage,
          args: ["Please set your Groq API key first!"]
        });
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showLoadingModal,
        args: [message.text, message.tone]
      });

      const rewritten = await callGroqAPI(message.text, message.tone);
      await StatsManager.updateStats(message.tone);

      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showRewriteResult,
        args: [message.text, rewritten, message.tone]
      });

    } catch (error) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        func: showErrorMessage,
        args: [error.message]
      });
    }
  }
});

function showErrorMessage(message) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showError(message);
  } else {
    alert("Smart Rewrite Error: " + message);
  }
}

function showLoadingModal(originalText, tone) {
  if (window.SmartRewriteModal) {
    window.SmartRewriteModal.showLoading(originalText, tone);
  }
}

function showRewriteResult(originalText, rewrittenText, tone) {
  const selection = window.getSelection();
  const activeElement = document.activeElement;
  
  const canReplace = activeElement && 
    (activeElement.tagName === 'TEXTAREA' || 
     activeElement.tagName === 'INPUT' || 
     activeElement.contentEditable === 'true') &&
    selection.rangeCount > 0;

  if (canReplace) {
    if (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT') {
      const start = activeElement.selectionStart;
      const end = activeElement.selectionEnd;
      const value = activeElement.value;
      activeElement.value = value.substring(0, start) + rewrittenText + value.substring(end);
      activeElement.setSelectionRange(start, start + rewrittenText.length);
      activeElement.focus();
    } else if (activeElement.contentEditable === 'true') {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(rewrittenText));
    }
    
    if (window.SmartRewriteModal) {
      window.SmartRewriteModal.showSuccess("Text replaced successfully!");
    }
  } else {
    if (window.SmartRewriteModal) {
      window.SmartRewriteModal.showResult(originalText, rewrittenText, tone);
    } else {
      navigator.clipboard.writeText(rewrittenText).then(() => {
        alert("Rewritten text copied to clipboard:\n\n" + rewrittenText);
      }).catch(() => {
        alert("Rewritten text:\n\n" + rewrittenText);
      });
    }
  }
}

async function callGroqAPI(text, tone) {
  const apiKey = await APIKeyManager.getAPIKey();
  if (!apiKey) {
    throw new Error("API key not found. Please set it in the extension popup.");
  }

  if (!isValidGroqAPIKey(apiKey)) {
    throw new Error("Invalid API key format. Please check your Groq API key.");
  }

  const prompt = buildSophisticatedPrompt(text, tone);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
      temperature: getTemperatureForTone(tone),
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      stream: false
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    
    if (response.status === 401) {
      throw new Error("Invalid API key. Please check your Groq API key in the extension settings.");
    } else if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please try again in a moment.");
    } else if (response.status === 400) {
      throw new Error("Request error: " + (errorData.error?.message || "Invalid request"));
    } else {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
  }

  const data = await response.json();
  
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error("Invalid API response format");
  }
  
  return data.choices[0].message.content.trim();
}

function buildSophisticatedPrompt(text, tone) {
  const toneInstructions = {
    friendly: `Rewrite the following text in a warm, approachable, and conversational tone. 
    Use inclusive language, contractions, and positive phrasing. 
    Make it sound like a helpful friend or colleague offering assistance.
    Keep the core meaning intact while making it more engaging and personable.`,
    
    professional: `Rewrite the following text in a formal, polished, and business-appropriate tone.
    Use precise language, avoid colloquialisms, and maintain a respectful demeanor.
    Structure the content logically with clear points while preserving all important information.
    Ensure it would be appropriate for a business communication, report, or professional setting.`,
    
    short: `Rewrite the following text to be concise and direct while preserving the core meaning.
    Eliminate redundancy, unnecessary words, and verbose expressions.
    Prioritize clarity and impact over elaboration.
    Create the most efficient version possible without losing essential information.`,

    linkedin: `Rewrite the text in an engaging, achievement-focused LinkedIn style.
    Use power words, metrics, and compelling language that highlights value.
    Include appropriate professional buzzwords and industry terminology.
    Make achievements sound more impressive while maintaining credibility.
    Focus on impact and results-oriented language.`,

    academic: `Rewrite the text in a scholarly, analytical academic style.
    Use formal language, precise terminology, and objective tone.
    Include logical structure and evidence-based reasoning.
    Maintain intellectual rigor while ensuring clarity.
    Suitable for academic papers, research, or educational content.`,

    marketing: `Convert the text into persuasive marketing copy.
    Use compelling calls-to-action and benefit-focused language.
    Incorporate emotional triggers and persuasive techniques.
    Emphasize unique value propositions and customer benefits.
    Create urgency while maintaining professionalism and credibility.`,

    simple: `Simplify the text using basic English vocabulary and structure.
    Use short sentences and common words that everyone can understand.
    Avoid jargon, idioms, and complex phrases.
    Make content accessible to non-native English speakers and general audiences.
    Maintain clarity while reducing complexity.`,

    executive: `Condense the text into a clear executive summary format.
    Focus on key points, decisions, and business impact.
    Use business-appropriate language and strategic framing.
    Prioritize actionable insights and bottom-line results.
    Structure for quick scanning by busy executives and decision-makers.`,

    translate: `Translate the following text into English only.
    Do not rewrite, summarize, or change the meaning.
    Preserve the original tone, style, and nuances as much as possible.
    Provide a clear and accurate English translation only.`,
  };

  const baseInstruction = toneInstructions[tone] || toneInstructions.friendly;
  
  return `You are an expert writing assistant. ${baseInstruction}

Text to rewrite:
"""
${text}
"""

Important guidelines:
- Preserve all factual information and key points
- Maintain appropriate technical terms when necessary
- Ensure grammatical correctness and readability
- Adapt to the requested tone consistently throughout
- Keep the same general length unless the tone specifically requires otherwise
- Output ONLY the rewritten text without any additional commentary or explanations

Rewritten text:`;
}

function getTemperatureForTone(tone) {
  const temperatures = {
    friendly: 0.7,
    professional: 0.3,
    short: 0.4,
    linkedin: 0.7,
    academic: 0.3,
    marketing: 0.8,
    simple: 0.4,
    executive: 0.5,
    translate: 0.2
  };
  
  return temperatures[tone] || 0.5;
}