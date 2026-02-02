import { AsyncLocalStorage } from 'async_hooks';
import { Request } from 'express';

// Создаем хранилище контекста
const requestStorage = new AsyncLocalStorage<Request>();

// Middleware, который нужно подключить в самый верх Express app
export const contextMiddleware = (req: Request, res: any, next: any) => {
  requestStorage.run(req, () => {
    next();
  });
};

// ТА САМАЯ ФУНКЦИЯ-ЭКСТРАКТОР
// Импортируй её где угодно и вызывай: const req = getCurrentRequest();
export const getCurrentRequest = (): Request | undefined => {
  return requestStorage.getStore();
};