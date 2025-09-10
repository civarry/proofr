// === API Key Manager Class ===
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

// === Context Menu Creation ===
chrome.runtime.onInstalled.addListener(() => {
  // Create parent menu item
  chrome.contextMenus.create({
    id: "smartRewrite",
    title: "Smart Rewrite",
    contexts: ["selection"]
  });

  // Create submenu items for different tones
  const rewriteModes = [
    { id: "rewriteFriendly", title: "Friendly Tone" },
    { id: "rewriteProfessional", title: "Professional Tone" },
    { id: "rewriteShort", title: "Concise Rewrite" },
    { id: "rewriteLinkedin", title: "LinkedIn Ready" },
    { id: "rewriteAcademic", title: "Academic Style" },
    { id: "rewriteMarketing", title: "Marketing Copy" },
    { id: "rewriteSimple", title: "Plain English" },
    { id: "rewriteExecutive", title: "Executive Brief" }
  ];

  rewriteModes.forEach(mode => {
    chrome.contextMenus.create({
      id: mode.id,
      parentId: "smartRewrite",
      title: mode.title,
      contexts: ["selection"]
    });
  });
});

// === Handle Menu Clicks ===
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId.startsWith("rewrite")) {
    try {
      // Check if API key exists
      const hasKey = await APIKeyManager.hasAPIKey();
      if (!hasKey) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => alert("Please set your Groq API key in the extension popup first!")
        });
        return;
      }

      const tone = info.menuItemId.replace("rewrite", "").toLowerCase();
      const text = info.selectionText;

      if (!text || text.trim().length === 0) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => alert("Please select some text first!")
        });
        return;
      }

      const rewritten = await callGroqAPI(text, tone);
      
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: replaceSelectedText,
        args: [rewritten]
      });
    } catch (error) {
      console.error("Error rewriting text:", error);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (errorMsg) => alert("Error: " + errorMsg),
        args: [error.message]
      });
    }
  }
});

// === Function to Replace Selected Text (injected into page) ===
function replaceSelectedText(newText) {
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT' || activeElement.contentEditable === 'true')) {
      if (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT') {
        const start = activeElement.selectionStart;
        const end = activeElement.selectionEnd;
        const value = activeElement.value;
        activeElement.value = value.substring(0, start) + newText + value.substring(end);
        activeElement.setSelectionRange(start, start + newText.length);
      } else {
        range.deleteContents();
        range.insertNode(document.createTextNode(newText));
      }
    } else {
      alert("Rewritten Text:\n\n" + newText);
    }
  } else {
    alert("Rewritten Text:\n\n" + newText);
  }
}

// === Groq API Call ===
async function callGroqAPI(text, tone) {
  const apiKey = await APIKeyManager.getAPIKey();
  if (!apiKey) {
    throw new Error("API key not found. Please set it in the extension popup.");
  }

  // Use the sophisticated prompt
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
      max_tokens: 500,
      temperature: getTemperatureForTone(tone),
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.1
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid API key. Please check your Groq API key.");
    } else if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please try again later.");
    } else {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
  }

  const data = await response.json();
  
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error("Invalid API response format");
  }
  
  return data.choices[0].message.content;
}

// Build sophisticated prompt function
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

    marketing: `Convert the text into persuasive marketing copy.
    Use compelling calls-to-action and benefit-focused language.
    Incorporate emotional triggers and persuasive techniques.
    Emphasize unique value propositions and customer benefits.
    Create urgency while maintaining professionalism.`,

    simple: `Simplify the text using basic English vocabulary and structure.
    Use short sentences and common words.
    Avoid idioms, jargon, and complex phrases.
    Make content accessible to non-native English speakers.
    Maintain clarity while reducing complexity.`,

    executive: `Condense the text into a clear executive summary.
    Focus on key points, decisions, and business impact.
    Use business-appropriate language and strategic framing.
    Prioritize actionable insights and bottom-line results.
    Structure for quick scanning by busy executives.`,
  };

  const baseInstruction = toneInstructions[tone] || toneInstructions.friendly;
  
  return `As an expert writing assistant, please ${baseInstruction}

Text to rewrite:
"""
${text}
"""

Guidelines:
- Preserve all factual information and key points
- Maintain appropriate technical terms when necessary
- Ensure grammatical correctness and readability
- Adapt to the requested tone consistently throughout
- Output only the rewritten text without additional commentary

Rewritten text:`;
}

// Add temperature control
function getTemperatureForTone(tone) {
  const temperatures = {
    friendly: 0.7,     // More creative for friendly tone
    professional: 0.3, // More deterministic for professional tone
    short: 0.4,       // Balanced for concise rewriting
    linkedin: 0.7,    // More creative for engagement
    academic: 0.3,    // More precise for accuracy
    marketing: 0.8,   // More creative for persuasion
    simple: 0.4,      // Balanced for clarity
    executive: 0.5    // Balanced for professionalism
  };
  
  return temperatures[tone] || 0.5;
}