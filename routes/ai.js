const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const aiService = require('../services/aiService');

function createRouter(io) {
  const router = express.Router();

  function createJob(userId) {
    const db = getDb();
    const result = db.prepare(
      'INSERT INTO analysis_jobs (user_id, status) VALUES (?, ?)'
    ).run(userId, 'pending');
    return result && result.lastInsertRowid ? result.lastInsertRowid : null;
  }

  function updateJobProgress(jobId, current, total) {
    const db = getDb();
    db.prepare(
      'UPDATE analysis_jobs SET progress_current = ?, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(current, total, jobId);
  }

  function completeJob(jobId, result) {
    const db = getDb();
    db.prepare(
      `UPDATE analysis_jobs SET status = 'completed', progress_current = ?, progress_total = ?,
       output_table = ?, provider = ?, model = ?, chunks_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(
      result.chunks,
      result.chunks,
      result.table,
      result.provider,
      result.model,
      result.chunks,
      jobId
    );
  }

  function failJob(jobId, errMessage) {
    const db = getDb();
    db.prepare(
      "UPDATE analysis_jobs SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(errMessage || 'خطأ غير معروف', jobId);
  }

  function setJobRunning(jobId, total) {
    const db = getDb();
    db.prepare(
      "UPDATE analysis_jobs SET status = 'running', progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(total, jobId);
  }

  function getJob(jobId, userId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM analysis_jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
    return row;
  }

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

  router.post('/analyze', requireAuth, (req, res) => {
    try {
      const { text } = req.body;
      if (!text || text.trim().length < 10) {
        return res.json({ success: false, message: 'النص قصير جداً للتحليل' });
      }
      const userId = req.session.userId;
      const jobId = createJob(userId);
      if (!jobId) {
        return res.json({ success: false, message: 'فشل إنشاء المهمة' });
      }
      const totalChunks = Math.ceil(text.length / 12000) || 1;
      setJobRunning(jobId, totalChunks);

      res.json({ success: true, jobId, message: 'تم استلام المهمة، جاري التحليل في الخلفية' });

      setImmediate(() => {
        const emit = (event, data) => {
          if (io) io.to(`analysis:${jobId}`).emit(event, { jobId, ...data });
        };
        aiService
          .analyzeMessages(text, (progress) => {
            updateJobProgress(jobId, progress.chunk, progress.total);
            emit('analysis:progress', { chunk: progress.chunk, total: progress.total, status: progress.status });
          })
          .then((result) => {
            completeJob(jobId, result);
            emit('analysis:done', {
              status: 'completed',
              table: result.table,
              provider: result.provider,
              model: result.model,
              chunks: result.chunks,
            });
          })
          .catch((err) => {
            failJob(jobId, err.message);
            emit('analysis:error', { status: 'failed', message: err.message });
          });
      });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.get('/analysis/:jobId', requireAuth, (req, res) => {
    try {
      const userId = req.session.userId;
      const job = getJob(Number(req.params.jobId), userId);
      if (!job) {
        return res.json({ success: false, message: 'المهمة غير موجودة أو لا تخصك' });
      }
      const payload = {
        success: true,
        jobId: job.id,
        status: job.status,
        progressCurrent: job.progress_current,
        progressTotal: job.progress_total,
      };
      if (job.status === 'completed') {
        payload.table = job.output_table;
        payload.provider = job.provider;
        payload.model = job.model;
        payload.chunks = job.chunks_count;
      }
      if (job.status === 'failed') {
        payload.message = job.error_message;
      }
      res.json(payload);
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.get('/jobs', requireAuth, (req, res) => {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          'SELECT id, status, progress_current, progress_total, provider, model, chunks_count, created_at, updated_at FROM analysis_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
        )
        .all(req.session.userId);
      res.json({ success: true, jobs: rows });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  router.get('/history', requireAuth, (req, res) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        'SELECT id, provider, model, chunks_count, status, created_at FROM message_analyses ORDER BY created_at DESC LIMIT 20'
      ).all();
      res.json({ success: true, history: rows });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  });

  return router;
}

module.exports = createRouter;
