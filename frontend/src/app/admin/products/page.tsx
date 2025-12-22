'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search, Edit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import api from '@/lib/api';
import { Product, ProductCategory } from '@/types';
import { formatCurrency } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { usePermissions } from '@/hooks/usePermissions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function ProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showProductForm, setShowProductForm] = useState(false);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const itemsPerPage = 20;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { hasPermission } = usePermissions();
  const canEditProduct = hasPermission('EDIT_PRODUCT');

  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowProductForm(true);
    }
    loadCategories();
  }, [searchParams]);

  useEffect(() => {
    loadProducts();
  }, [currentPage, selectedCategory]);

  const loadCategories = async () => {
    try {
      const categoriesRes = await api.get('/products/categories');
      const categoriesData = Array.isArray(categoriesRes.data)
        ? categoriesRes.data
        : (categoriesRes.data?.categories || []);
      setCategories(categoriesData);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load categories',
        variant: 'destructive',
      });
      setCategories([]);
    }
  };

  const loadProducts = async () => {
    try {
      setIsLoading(true);
      const productsRes = await api.get('/products', {
        params: {
          search: searchQuery || undefined,
          categoryId: selectedCategory || undefined,
          page: currentPage,
          limit: itemsPerPage
        },
      });
      const productsData = Array.isArray(productsRes.data)
        ? productsRes.data
        : (productsRes.data?.products || []);

      setProducts(productsData);
      setTotalPages(productsRes.data.pagination?.totalPages || 1);
      setTotalItems(productsRes.data.pagination?.total || 0);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load products',
        variant: 'destructive',
      });
      setProducts([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    loadProducts();
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleCategoryFilter = (categoryId: string) => {
    setSelectedCategory(categoryId);
    setCurrentPage(1);
  };

  const handleEditClick = (product: any) => {
    setEditingProduct(product);
    setShowEditDialog(true);
  };

  const handleEditSuccess = () => {
    setShowEditDialog(false);
    setEditingProduct(null);
    loadProducts();
  };

  const loadData = async () => {
    await Promise.all([loadCategories(), loadProducts()]);
  };

  if (showProductForm) {
    return (
      <ProductForm
        categories={categories}
        onClose={() => setShowProductForm(false)}
        onSuccess={() => {
          setShowProductForm(false);
          loadData();
        }}
      />
    );
  }

  if (showCategoryForm) {
    return (
      <CategoryForm
        onClose={() => setShowCategoryForm(false)}
        onSuccess={() => {
          setShowCategoryForm(false);
          loadData();
        }}
      />
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Products</h1>
          <p className="text-gray-600 mt-1">Manage products and categories</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowCategoryForm(true)}>
            Add Category
          </Button>
          <Button onClick={() => setShowProductForm(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Product
          </Button>
        </div>
      </div>

      {/* Categories Section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Product Categories</CardTitle>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No categories found</p>
              <Button className="mt-4" variant="outline" onClick={() => setShowCategoryForm(true)}>
                Add First Category
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Badge
                key="all"
                variant={selectedCategory === '' ? 'default' : 'secondary'}
                className="px-3 py-1.5 cursor-pointer"
                onClick={() => handleCategoryFilter('')}
              >
                All Products
              </Badge>
              {categories.map((category) => (
                <Badge
                  key={category.id}
                  variant={selectedCategory === category.id ? 'default' : 'secondary'}
                  className="px-3 py-1.5 cursor-pointer"
                  onClick={() => handleCategoryFilter(category.id)}
                >
                  {category.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Products Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <CardTitle>All Products</CardTitle>
            </div>
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  placeholder="Search by product name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="pl-10"
                />
              </div>
              <Button onClick={handleSearch}>Search</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No products found</p>
              <Button className="mt-4" onClick={() => setShowProductForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add First Product
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Base Price</TableHead>
                  <TableHead>Inventory</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">{product.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{product.category?.name || '-'}</Badge>
                    </TableCell>
                    <TableCell>{formatCurrency(product.basePrice)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-green-600">
                          {product.availableInventory || 0}
                        </span>
                        <span className="text-gray-500 text-sm">
                          / {product.totalInventory || 0}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={product.isActive ? 'default' : 'secondary'}>
                        {product.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {canEditProduct && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleEditClick(product)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => router.push(`/admin/inventory?productId=${product.id}&productName=${encodeURIComponent(product.name)}`)}
                        >
                          View Inventory
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {!isLoading && products.length > 0 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            totalItems={totalItems}
            itemsPerPage={itemsPerPage}
          />
        )}
      </Card>

      {/* Edit Product Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Product</DialogTitle>
            <DialogDescription>
              Update product details for {editingProduct?.name}
            </DialogDescription>
          </DialogHeader>
          {editingProduct && (
            <EditProductForm
              product={editingProduct}
              categories={categories}
              onClose={() => setShowEditDialog(false)}
              onSuccess={handleEditSuccess}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditProductForm({
  product,
  categories,
  onClose,
  onSuccess,
}: {
  product: any;
  categories: ProductCategory[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    name: product.name,
    description: product.description || '',
    basePrice: product.basePrice.toString(),
    categoryId: product.categoryId,
    isActive: product.isActive,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await api.put(`/products/${product.id}`, {
        ...formData,
        basePrice: parseFloat(formData.basePrice),
      });
      toast({
        title: 'Success',
        description: 'Product updated successfully',
      });
      onSuccess();
    } catch (error: any) {
      console.error('Update product error:', error);
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to update product',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2">Product Name *</label>
        <Input
          required
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Description</label>
        <textarea
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Base Price (GHS) *</label>
        <Input
          required
          type="number"
          step="0.01"
          min="0"
          value={formData.basePrice}
          onChange={(e) => setFormData({ ...formData, basePrice: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Category *</label>
        <select
          required
          className="flex h-9 w-full rounded-md border border-input bg-white px-3 py-1 text-sm"
          value={formData.categoryId}
          onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
        >
          <option value="">Select a category</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="isActive"
          checked={formData.isActive}
          onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
          className="h-4 w-4"
        />
        <label htmlFor="isActive" className="text-sm font-medium">
          Active
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Updating...' : 'Update Product'}
        </Button>
      </div>
    </form>
  );
}

function CategoryForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await api.post('/products/categories', formData);
      toast({ title: 'Success', description: 'Category created successfully' });
      onSuccess();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to create category',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8">
      <Card className="max-w-lg mx-auto">
        <CardHeader>
          <CardTitle>Add Product Category</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Category Name *</label>
              <Input
                required
                placeholder="e.g., Mobile Phones"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Description</label>
              <Input
                placeholder="Brief description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
            <div className="flex gap-4 pt-4">
              <Button type="submit" disabled={isSubmitting} className="flex-1">
                {isSubmitting ? 'Creating...' : 'Create Category'}
              </Button>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ProductForm({
  categories,
  onClose,
  onSuccess,
}: {
  categories: ProductCategory[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    basePrice: '',
    categoryId: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await api.post('/products', {
        ...formData,
        basePrice: parseFloat(formData.basePrice),
      });
      toast({ title: 'Success', description: 'Product created successfully' });
      onSuccess();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to create product',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>Add New Product</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Product Name *</label>
              <Input
                required
                placeholder="e.g., iPhone 15 Pro"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Description</label>
              <Input
                placeholder="Product details"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Category *</label>
                <select
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={formData.categoryId}
                  onChange={(e) => setFormData({ ...formData, categoryId: e.target.value })}
                >
                  <option value="">Select category</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Base Price (GHS) *</label>
                <Input
                  required
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.basePrice}
                  onChange={(e) => setFormData({ ...formData, basePrice: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <Button type="submit" disabled={isSubmitting} className="flex-1">
                {isSubmitting ? 'Creating...' : 'Create Product'}
              </Button>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
