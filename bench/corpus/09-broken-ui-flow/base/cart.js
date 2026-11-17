export const canPlaceOrder = (cart) => cart.items.length > 0 && cart.address !== null;
