// Small fetch wrapper: JSON in, JSON out, and an error that says which service failed.
export async function requestJson(fetchImpl, service, url, { method = 'GET', headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`${service} ${method} ${new URL(url).pathname} failed (${res.status}): ${detail?.slice(0, 500)}`);
  }
  return data;
}
