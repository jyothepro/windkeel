// Seeded defect: the address requirement is dropped, and the Place order button now
// enables before the form is complete, so the flow dead-ends at the payment step.
export const canPlaceOrder = (cart) => cart.items.length > 0;
