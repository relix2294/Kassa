import type { Request } from 'express';

// Кассир не видит закупочные цены и себестоимость чека (п.4 ТЗ).
// Владелец видит всё как есть.

export function isOwner(req: Request): boolean {
  return req.user?.role === 'owner';
}

export function productFor(req: Request, product: any) {
  if (isOwner(req) || !product) return product;
  const { cost_price, ...rest } = product;
  return rest;
}

export function productsFor(req: Request, products: any[]) {
  if (isOwner(req)) return products;
  return products.map((p) => {
    const { cost_price, ...rest } = p;
    return rest;
  });
}

// Чек: себестоимость — это маржа, кассиру её знать не положено.
export function saleFor(req: Request, sale: any) {
  if (isOwner(req) || !sale) return sale;
  const { cost_total, ...rest } = sale;
  return rest;
}
