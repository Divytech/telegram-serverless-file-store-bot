import { api } from 'sdk';

export default async function (query) {
  if (!query?.id) return;
  try {
    await api.answerCallbackQuery({ callback_query_id: query.id });
  } catch (err) {}
}
