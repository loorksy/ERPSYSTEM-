const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const aiService = require('../services/aiService');

router.get('/status', requireAuth, (req, res) => {
  res.json(aiService.getAIStatus());
});

router.post('/save-key', requireAuth, async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) {
      return res.json({ success: false, message: 'المزوّد ومفتاح API مطلوبان' });
    }
    if (!['openai', 'gemini'].includes(provider)) {
      return res.json({ success: false, message: 'مزوّد غير مدعوم' });
    }

    aiService.saveApiKey(provider, apiKey.trim());

    const models = await aiService.fetchModels(provider, apiKey.trim());
    if (models.length > 0) {
      aiService.saveModelsCache(provider, models);
    }

    res.json({
      success: true,
      message: `تم حفظ مفتاح ${provider === 'openai' ? 'OpenAI' : 'Gemini'} بنجاح`,
      models,
    });
  } catch (err) {
    res.json({ success: false, message: 'فشل حفظ المفتاح: ' + err.message });
  }
});

router.post('/select-model', requireAuth, (req, res) => {
  try {
    const { provider, model } = req.body;
    if (!provider || !model) {
      return res.json({ success: false, message: 'المزوّد والموديل مطلوبان' });
    }
    aiService.saveSelectedModel(provider, model);
    res.json({ success: true, message: `تم اختيار الموديل: ${model}` });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/refresh-models', requireAuth, async (req, res) => {
  try {
    const { provider } = req.body;
    const config = aiService.getProviderConfig(provider);
    if (!config || !config.apiKey) {
      return res.json({ success: false, message: 'مفتاح API غير موجود لهذا المزوّد' });
    }
    const models = await aiService.fetchModels(provider, config.apiKey);
    aiService.saveModelsCache(provider, models);
    res.json({ success: true, models });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/analyze', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 10) {
      return res.json({ success: false, message: 'النص قصير جداً للتحليل' });
    }
    const result = await aiService.analyzeMessages(text);
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/history', requireAuth, (req, res) => {
  try {
    const { getDb } = require('../db/database');
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, provider, model, chunks_count, status, created_at FROM message_analyses ORDER BY created_at DESC LIMIT 20'
    ).all();
    res.json({ success: true, history: rows });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
