# Cloudflare AI implementation notes

تمت مراجعة توثيق Cloudflare في 24 نوفمبر 2026 قبل تنفيذ شات Zazo.

## القرار التقني

- يستخدم Worker binding باسم `AI` لاستدعاء `env.AI.run(model, input)`. النموذج العام المنشور حاليًا هو `@cf/openai/gpt-oss-120b`، وهو وزن جاهز مستضاف من Cloudflare ومناسب للمحادثة متعددة اللغات.
- تستخدم D1 كمصدر الحقيقة لسجلات JSONL بعد تحويل كل سطر إلى `chat_knowledge_records`، ولا تستخدم KV بدلًا منها.
- تستخدم KV باسم `CHAT_CACHE` لتخزين نتيجة البحث/الإجابة مؤقتًا بمفتاح hash للسؤال، مع TTL، ويمكن حذف الكاش عند تحديث المعرفة.
- يستخدم الشات RAG بسيطًا: تطبيع السؤال، مطابقة الكلمات/النوايا في D1، ثم تمرير السجلات الأقرب إلى النموذج داخل system prompt مقيد بالمعلومات المرجعية.
- LoRA ليس “محوّلًا” يُدرَّب داخل KV. Cloudflare يدعم LoRA adapters متوافقة مع نماذج معينة عبر fine-tune API/Wrangler، ثم تُمرَّر قيمة `lora` عند inference. لم يتم اختلاق adapter أو رفع أوزان غير موجودة. الكود يدعم `AI_LORA_NAME` اختياريًا، ويعمل بدونه باستخدام نموذج Cloudflare عام.

## المصادر الأصلية

1. https://developers.cloudflare.com/workers-ai/configuration/bindings/
2. https://developers.cloudflare.com/workers/wrangler/configuration/
3. https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/
4. https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/
5. https://developers.cloudflare.com/workers-ai/models/
