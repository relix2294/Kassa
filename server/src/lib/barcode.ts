// Поиск названия товара по штрихкоду во внешней базе.
// РИСК (п.10 ТЗ): местные таджикские товары могут отсутствовать во внешней базе.
// Поэтому lookup опционален: если не настроен или не нашёл — возвращаем null,
// и владелец вводит название вручную.

interface BarcodeInfo {
  name: string | null;
  source: string | null;
}

export async function lookupBarcode(barcode: string): Promise<BarcodeInfo> {
  const url = process.env.BARCODE_LOOKUP_URL;
  if (!url) return { name: null, source: null };

  try {
    // Ожидаем URL с плейсхолдером {barcode}, напр. https://api.example.com/{barcode}
    const target = url.replace('{barcode}', encodeURIComponent(barcode));
    const res = await fetch(target, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { name: null, source: null };
    const data: any = await res.json();
    // Пытаемся достать название из типичных полей разных баз.
    const name =
      data?.product?.product_name ||
      data?.product_name ||
      data?.title ||
      data?.name ||
      null;
    return { name: name ?? null, source: name ? 'external' : null };
  } catch {
    return { name: null, source: null };
  }
}
